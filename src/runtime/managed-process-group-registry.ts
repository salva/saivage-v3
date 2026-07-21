import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ProcessCategory = 'runtime_card' | 'operator_session' | 'service_infrastructure';
export type ManagedGroupState = 'active' | 'terminating' | 'unverifiable';

declare const managedProcessScopeBrand: unique symbol;
export interface ManagedProcessScope {
  readonly [managedProcessScopeBrand]: true;
}

type ScopeKind = 'container' | 'direct';

interface ScopeRecord {
  readonly scope: ManagedProcessScope;
  readonly parent: ManagedProcessScope | null;
  readonly kind: ScopeKind;
  readonly label: string;
  readonly category: ProcessCategory | null;
  open: boolean;
}

interface GroupRecord {
  readonly groupId: string;
  readonly pgid: number;
  readonly child: ChildProcess;
  readonly directScope: ManagedProcessScope;
  readonly category: ProcessCategory;
  readonly onAbsent: (reason: string | null) => void;
  state: ManagedGroupState;
  diagnostic: string | null;
  terminationReason: string | null;
  leaderExited: boolean;
  settlement: Promise<void>;
  resolveSettlement: () => void;
}

export interface ProcessStopReport {
  selected: string[];
  stopped: string[];
  failed: Array<{
    groupId: string;
    state: 'unconfirmed' | 'unverifiable';
    diagnostic: string;
  }>;
}

export interface ManagedProcessLaunch {
  groupId: string;
  directScope: ManagedProcessScope;
  category: ProcessCategory;
  file: string;
  args: readonly string[];
  options: SpawnOptions;
  onAbsent: (reason: string | null) => void;
}

export interface ManagedProcessPlatform {
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  probe(pgid: number): void;
  signal(pgid: number, signal: NodeJS.Signals): void;
}

const posixPlatform: ManagedProcessPlatform = {
  spawn: (file, args, options) => spawn(file, args, options),
  probe: (pgid) => process.kill(-pgid, 0),
  signal: (pgid, signal) => process.kill(-pgid, signal),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ManagedProcessGroupRegistry {
  private readonly scopes = new Map<ManagedProcessScope, ScopeRecord>();
  private readonly groups = new Map<string, GroupRecord>();
  private launchAdmissionOpen = true;
  readonly rootScope: ManagedProcessScope;

  constructor(private readonly platform: ManagedProcessPlatform = posixPlatform) {
    this.rootScope = this.allocateScope(null, 'container', 'managed-processes', null);
  }

  createContainerScope(parent: ManagedProcessScope, label: string): ManagedProcessScope {
    this.assertScope(parent, 'container');
    return this.allocateScope(parent, 'container', label, null);
  }

  createDirectScope(parent: ManagedProcessScope, label: string, category: ProcessCategory): ManagedProcessScope {
    this.assertScope(parent, 'container');
    return this.allocateScope(parent, 'direct', label, category);
  }

  closeScope(scope: ManagedProcessScope): void {
    const record = this.requireKnownScope(scope);
    record.open = false;
  }

  closeLaunchAdmission(): void {
    this.launchAdmissionOpen = false;
  }

  launch(input: ManagedProcessLaunch): ChildProcess {
    if (!this.launchAdmissionOpen) throw new Error('Managed process launch admission is closed.');
    if (this.groups.has(input.groupId)) throw new Error(`Managed process group '${input.groupId}' already exists.`);
    const scope = this.assertScope(input.directScope, 'direct');
    if (scope.category !== input.category) {
      throw new Error(`Managed process scope category '${scope.category}' does not authorize '${input.category}'.`);
    }

    const child = this.platform.spawn(input.file, input.args, { ...input.options, detached: true });
    child.on('error', () => {});
    if (!child.pid) {
      child.kill();
      throw new Error(`Managed process group '${input.groupId}' has no leader PID.`);
    }

    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve; });
    const record: GroupRecord = {
      groupId: input.groupId,
      pgid: child.pid,
      child,
      directScope: input.directScope,
      category: input.category,
      onAbsent: input.onAbsent,
      state: 'active',
      diagnostic: null,
      terminationReason: null,
      leaderExited: false,
      settlement,
      resolveSettlement,
    };
    this.groups.set(input.groupId, record);
    child.once('exit', () => {
      record.leaderExited = true;
      queueMicrotask(() => { void this.observeNaturalAbsence(record); });
    });
    return child;
  }

  bindingMatches(groupId: string, directScope: ManagedProcessScope, category: ProcessCategory): boolean {
    const scope = this.requireKnownScope(directScope);
    const group = this.groups.get(groupId);
    return scope.kind === 'direct' && scope.open && scope.category === category
      && group?.directScope === directScope && group.category === category;
  }

  async terminateGroup(input: { groupId: string; directScope: ManagedProcessScope; category: ProcessCategory; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    const scope = this.assertScope(input.directScope, 'direct', false);
    if (scope.category !== input.category) throw new Error(`Managed process scope category '${scope.category}' does not authorize '${input.category}'.`);
    const group = this.groups.get(input.groupId);
    if (!group) return { selected: [], stopped: [], failed: [] };
    if (group.directScope !== input.directScope || group.category !== input.category) {
      throw new Error(`Managed process group '${input.groupId}' is not bound to the invoking direct scope and category.`);
    }
    return this.terminateRecords([group], input.reason, input.graceMs ?? 5_000);
  }

  terminateScopeTree(input: { rootScope: ManagedProcessScope; categories: readonly ProcessCategory[]; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    this.requireKnownScope(input.rootScope);
    const categories = new Set(input.categories);
    const selected = [...this.groups.values()].filter((group) => categories.has(group.category) && this.isDescendant(group.directScope, input.rootScope));
    return this.terminateRecords(selected, input.reason, input.graceMs ?? 5_000);
  }

  wait(groupId: string): Promise<void> | null {
    return this.groups.get(groupId)?.settlement ?? null;
  }

  isLive(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  state(groupId: string): ManagedGroupState | null {
    return this.groups.get(groupId)?.state ?? null;
  }

  childProcess(groupId: string): ChildProcess | null {
    return this.groups.get(groupId)?.child ?? null;
  }

  private allocateScope(parent: ManagedProcessScope | null, kind: ScopeKind, label: string, category: ProcessCategory | null): ManagedProcessScope {
    const scope = Object.freeze({}) as ManagedProcessScope;
    this.scopes.set(scope, { scope, parent, kind, label, category, open: true });
    return scope;
  }

  private requireKnownScope(scope: ManagedProcessScope): ScopeRecord {
    const record = this.scopes.get(scope);
    if (!record) throw new Error('Managed process scope capability was not allocated by this registry.');
    return record;
  }

  private assertScope(scope: ManagedProcessScope, kind: ScopeKind, requireOpen = true): ScopeRecord {
    const record = this.requireKnownScope(scope);
    if (record.kind !== kind) throw new Error(`Managed process scope '${record.label}' is not a ${kind} scope.`);
    if (requireOpen && !record.open) throw new Error(`Managed process scope '${record.label}' is closed.`);
    return record;
  }

  private isDescendant(scope: ManagedProcessScope, root: ManagedProcessScope): boolean {
    let current: ScopeRecord | undefined = this.requireKnownScope(scope);
    while (current) {
      if (current.scope === root) return true;
      current = current.parent ? this.scopes.get(current.parent) : undefined;
    }
    return false;
  }

  private async observeNaturalAbsence(record: GroupRecord): Promise<void> {
    while (this.groups.get(record.groupId) === record && record.state === 'active') {
      const result = this.probe(record);
      if (result === 'absent' || result === 'ambiguous') return;
      await delay(50);
    }
  }

  private probe(record: GroupRecord): 'live' | 'absent' | 'ambiguous' {
    if (record.state === 'unverifiable') return 'ambiguous';
    try {
      this.platform.probe(record.pgid);
      return 'live';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.confirmAbsent(record);
        return 'absent';
      }
      this.markUnverifiable(record, `Process-group probe failed: ${diagnostic(error)}`);
      return 'ambiguous';
    }
  }

  private signal(record: GroupRecord, signal: NodeJS.Signals): boolean {
    if (record.state === 'unverifiable') return false;
    try {
      this.platform.signal(record.pgid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      this.markUnverifiable(record, `${signal} dispatch failed: ${diagnostic(error)}`);
      return false;
    }
  }

  private markUnverifiable(record: GroupRecord, message: string): void {
    record.state = 'unverifiable';
    record.diagnostic = message;
  }

  private confirmAbsent(record: GroupRecord): void {
    if (this.groups.get(record.groupId) !== record) return;
    this.groups.delete(record.groupId);
    record.onAbsent(record.terminationReason);
    record.resolveSettlement();
  }

  private async waitForAbsence(record: GroupRecord, timeoutMs: number): Promise<'absent' | 'live' | 'ambiguous'> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = this.probe(record);
      if (result !== 'live') return result;
      if (Date.now() >= deadline) return 'live';
      await delay(50);
    }
  }

  private async terminateRecords(records: readonly GroupRecord[], reason: string, graceMs: number): Promise<ProcessStopReport> {
    const report: ProcessStopReport = { selected: records.map((record) => record.groupId), stopped: [], failed: [] };
    const candidates: GroupRecord[] = [];
    for (const record of records) {
      if (record.state === 'unverifiable') {
        report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
        continue;
      }
      const initial = this.probe(record);
      if (initial === 'absent') report.stopped.push(record.groupId);
      else if (initial === 'ambiguous') report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
      else candidates.push(record);
    }

    for (const record of candidates) {
      record.state = 'terminating';
      record.terminationReason = reason;
      if (!this.signal(record, 'SIGTERM')) {
        report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
      }
    }

    const afterTerm = await Promise.all(candidates.map(async (record) => {
      if (record.state === 'unverifiable') return 'ambiguous' as const;
      return this.waitForAbsence(record, graceMs);
    }));
    const killCandidates: GroupRecord[] = [];
    afterTerm.forEach((result, index) => {
      const record = candidates[index]!;
      if (result === 'absent') report.stopped.push(record.groupId);
      else if (result === 'ambiguous') {
        if (!report.failed.some((failure) => failure.groupId === record.groupId)) report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
      } else killCandidates.push(record);
    });

    for (const record of killCandidates) {
      if (!this.signal(record, 'SIGKILL')) report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
    }
    const afterKill = await Promise.all(killCandidates.map(async (record) => {
      if (record.state === 'unverifiable') return 'ambiguous' as const;
      return this.waitForAbsence(record, 2_000);
    }));
    afterKill.forEach((result, index) => {
      const record = killCandidates[index]!;
      if (result === 'absent') report.stopped.push(record.groupId);
      else if (result === 'ambiguous') {
        if (!report.failed.some((failure) => failure.groupId === record.groupId)) report.failed.push({ groupId: record.groupId, state: 'unverifiable', diagnostic: record.diagnostic! });
      } else {
        record.state = 'active';
        if (record.leaderExited) queueMicrotask(() => { void this.observeNaturalAbsence(record); });
        report.failed.push({ groupId: record.groupId, state: 'unconfirmed', diagnostic: 'Process group remained live after SIGTERM and SIGKILL.' });
      }
    });
    return report;
  }
}
