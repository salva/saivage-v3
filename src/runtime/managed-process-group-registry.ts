import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ProcessCategory = 'runtime_card' | 'operator_session' | 'service_infrastructure';
export type ManagedGroupState = 'active' | 'terminating' | 'unverifiable';

declare const managedProcessScopeBrand: unique symbol;
export interface ManagedProcessScope {
  readonly [managedProcessScopeBrand]: true;
}

interface ScopeRecordBase {
  readonly scope: ManagedProcessScope;
  readonly parent: ManagedProcessScope | null;
  readonly label: string;
  open: boolean;
}

interface ContainerScopeRecord extends ScopeRecordBase {
  readonly kind: 'container';
  readonly category: null;
}

interface DirectScopeRecord extends ScopeRecordBase {
  readonly kind: 'direct';
  readonly category: ProcessCategory;
  readonly groups: Map<string, GroupRecord>;
}

type ScopeRecord = ContainerScopeRecord | DirectScopeRecord;

interface GroupRecord {
  readonly groupId: string;
  readonly pgid: number;
  readonly child: ChildProcess;
  readonly directScope: ManagedProcessScope;
  readonly directScopeRecord: DirectScopeRecord;
  readonly category: ProcessCategory;
  readonly onAbsent: (reason: string | null) => void;
  state: ManagedGroupState;
  diagnostic: string | null;
  terminationReason: string | null;
  leaderExited: boolean;
  absenceConfirmed: boolean;
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
    if (record.kind === 'direct' && record.groups.size === 0) this.retireDirectScope(record);
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
      directScopeRecord: scope,
      category: input.category,
      onAbsent: input.onAbsent,
      state: 'active',
      diagnostic: null,
      terminationReason: null,
      leaderExited: false,
      absenceConfirmed: false,
      settlement,
      resolveSettlement,
    };
    this.groups.set(input.groupId, record);
    scope.groups.set(input.groupId, record);
    child.once('exit', () => {
      record.leaderExited = true;
      queueMicrotask(() => { void this.observeNaturalAbsence(record); });
    });
    return child;
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

  closeAndTerminateDirectScope(input: { directScope: ManagedProcessScope; category: ProcessCategory; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    const scope = this.assertScope(input.directScope, 'direct');
    if (scope.category !== input.category) throw new Error(`Managed process scope category '${scope.category}' does not authorize '${input.category}'.`);
    scope.open = false;
    const selected = [...scope.groups.values()];
    if (selected.length === 0) {
      this.retireDirectScope(scope);
      return Promise.resolve({ selected: [], stopped: [], failed: [] });
    }
    return this.terminateRecords(selected, input.reason, input.graceMs ?? 5_000);
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

  private allocateScope(parent: ManagedProcessScope | null, kind: 'container', label: string, category: null): ManagedProcessScope;
  private allocateScope(parent: ManagedProcessScope, kind: 'direct', label: string, category: ProcessCategory): ManagedProcessScope;
  private allocateScope(parent: ManagedProcessScope | null, kind: ScopeRecord['kind'], label: string, category: ProcessCategory | null): ManagedProcessScope {
    const scope = Object.freeze({}) as ManagedProcessScope;
    const record: ScopeRecord = kind === 'container'
      ? { scope, parent, kind, label, category: null, open: true }
      : { scope, parent, kind, label, category: category!, open: true, groups: new Map() };
    this.scopes.set(scope, record);
    return scope;
  }

  private requireKnownScope(scope: ManagedProcessScope): ScopeRecord {
    const record = this.scopes.get(scope);
    if (!record) throw new Error('Managed process scope capability was not allocated by this registry.');
    return record;
  }

  private assertScope(scope: ManagedProcessScope, kind: 'container', requireOpen?: boolean): ContainerScopeRecord;
  private assertScope(scope: ManagedProcessScope, kind: 'direct', requireOpen?: boolean): DirectScopeRecord;
  private assertScope(scope: ManagedProcessScope, kind: ScopeRecord['kind'], requireOpen = true): ScopeRecord {
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
    this.validateCapturedRecord(record);
    if (record.absenceConfirmed) {
      this.confirmAbsent(record);
      return 'absent';
    }
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
    this.validateCapturedRecord(record);
    if (record.absenceConfirmed) return true;
    if (record.state === 'unverifiable') return false;
    try {
      this.platform.signal(record.pgid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.confirmAbsent(record);
        return true;
      }
      this.markUnverifiable(record, `${signal} dispatch failed: ${diagnostic(error)}`);
      return false;
    }
  }

  private markUnverifiable(record: GroupRecord, message: string): void {
    record.state = 'unverifiable';
    record.diagnostic = message;
  }

  private confirmAbsent(record: GroupRecord): void {
    this.validateCapturedRecord(record);
    if (record.absenceConfirmed) return;
    record.absenceConfirmed = true;
    this.groups.delete(record.groupId);
    record.directScopeRecord.groups.delete(record.groupId);
    if (!record.directScopeRecord.open && record.directScopeRecord.groups.size === 0) {
      this.retireDirectScope(record.directScopeRecord);
    }
    record.onAbsent(record.terminationReason);
    record.resolveSettlement();
  }

  private validateCapturedRecord(record: GroupRecord): void {
    const currentGroup = this.groups.get(record.groupId);
    const currentMembership = record.directScopeRecord.groups.get(record.groupId);
    const currentScope = this.scopes.get(record.directScope);
    if (record.absenceConfirmed) {
      if (currentGroup !== undefined || currentMembership !== undefined) {
        throw new Error(`Managed process group '${record.groupId}' has conflicting current identity after confirmed absence.`);
      }
      if (currentScope !== undefined && currentScope !== record.directScopeRecord) {
        throw new Error(`Managed process group '${record.groupId}' has conflicting direct scope identity after confirmed absence.`);
      }
      return;
    }
    if (currentGroup !== record || currentMembership !== record || currentScope !== record.directScopeRecord
      || record.directScopeRecord.category !== record.category) {
      throw new Error(`Managed process group '${record.groupId}' current identity diverged before absence confirmation.`);
    }
  }

  private retireDirectScope(record: DirectScopeRecord): void {
    if (record.groups.size !== 0) throw new Error(`Managed process scope '${record.label}' cannot retire with live groups.`);
    if (this.scopes.get(record.scope) !== record) throw new Error(`Managed process scope '${record.label}' identity diverged before retirement.`);
    this.scopes.delete(record.scope);
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
