import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { cardProcessOutputRoot, nonCardProcessOutputRoot } from '../persistence/layout.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/index.js';
import { now } from '../utils/clock.js';
import { redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
import {
  ManagedProcessGroupRegistry,
  type ManagedProcessScope,
  type ProcessCategory,
  type ProcessStopReport,
} from './managed-process-group-registry.js';

export interface ProcessSpawnSpec {
  command: string;
  directScope: ManagedProcessScope;
  category: ProcessCategory;
  cardId?: string | null;
  ownerId: string;
  ownerKind: 'agent' | 'operator' | 'runtime';
  cwd?: string;
  env?: Record<string, string>;
  requiredForCardCompletion?: boolean;
  agentSessionId?: string;
  goalId?: string;
  launchReason?: string;
  backgroundPolicy?: 'foreground';
}

export interface InteractiveProcessSpawnSpec extends Omit<ProcessSpawnSpec, 'command' | 'backgroundPolicy' | 'env'> {
  file: string;
  args: readonly string[];
  stdio: SpawnOptions['stdio'];
  env: NodeJS.ProcessEnv;
}

export interface InteractiveProcessLaunch {
  record: ProcessRecord;
  process: ChildProcess;
}

export interface ProcessWaitResult {
  id: string;
  status: ProcessStatus;
  exitCode: number | null;
  timedOut: boolean;
  waitDurationMs: number;
}

export interface ProcessListFilter {
  cardId?: string;
  status?: ProcessStatus | ProcessStatus[];
}

interface ProcessPresentation {
  record: ProcessRecord;
  leaderOutcome: Pick<ProcessRecord, 'status' | 'exit_code' | 'signal' | 'terminal_reason'> | null;
  streams: { stdout: WriteStream; stderr: WriteStream } | null;
  streamClose: Promise<void> | null;
}

function generateId(): string {
  return `proc-${randomBytes(6).toString('hex')}`;
}

function nowMonotonic(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProcessRunner {
  private readonly presentations = new Map<string, ProcessPresentation>();
  private readonly bindings = new Map<string, { directScope: ManagedProcessScope; category: ProcessCategory }>();
  private readonly commandHashSalt = randomBytes(32);

  readonly runtimeRootScope: ManagedProcessScope;
  readonly analystRootScope: ManagedProcessScope;
  readonly mcpRootScope: ManagedProcessScope;

  constructor(readonly projectRoot: string, readonly registry: ManagedProcessGroupRegistry) {
    this.runtimeRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
    this.analystRootScope = registry.createContainerScope(registry.rootScope, 'analyst-sessions');
    this.mcpRootScope = registry.createContainerScope(registry.rootScope, 'mcp-servers');
  }

  spawn(spec: ProcessSpawnSpec): ProcessRecord {
    return this.launch(spec, 'sh', ['-c', spec.command], ['ignore', 'pipe', 'pipe'], true, { ...sanitizedCommandEnv(), PROJECT_ROOT: this.projectRoot, SAIVAGE_ROOT: this.projectRoot, ...spec.env }).record;
  }

  spawnInteractive(spec: InteractiveProcessSpawnSpec): InteractiveProcessLaunch {
    const command = [spec.file, ...spec.args].join(' ');
    return this.launch({ ...spec, command, env: undefined }, spec.file, spec.args, spec.stdio, false, spec.env);
  }

  async wait(procId: string, timeoutMs = 0): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) return { id: procId, status: 'failed', exitCode: null, timedOut: false, waitDurationMs: Date.now() - started };
    const settlement = this.registry.wait(procId);
    if (!settlement) {
      await presentation.streamClose;
      return this.waitResult(procId, false, started);
    }
    if (timeoutMs === 0) return this.waitResult(procId, false, started);
    const result = await Promise.race([settlement.then(() => 'settled' as const), delay(timeoutMs).then(() => 'timeout' as const)]);
    if (result === 'timeout' && this.registry.isLive(procId)) return this.waitResult(procId, true, started);
    await presentation.streamClose;
    return this.waitResult(procId, false, started);
  }

  async waitForSettlement(procId: string): Promise<ProcessWaitResult> {
    const started = Date.now();
    const presentation = this.presentations.get(procId);
    if (!presentation) return { id: procId, status: 'failed', exitCode: null, timedOut: false, waitDurationMs: 0 };
    await this.registry.wait(procId);
    await presentation.streamClose;
    return this.waitResult(procId, false, started);
  }

  async kill(procId: string, authority: { directScope: ManagedProcessScope; category: ProcessCategory; reason?: string; graceMs?: number }): Promise<ProcessRecord | null> {
    const record = this.get(procId);
    if (!record) return null;
    if (!this.bindingMatches(procId, authority.directScope, authority.category)) {
      throw new Error(`Managed process '${procId}' is not bound to the invoking direct scope and category.`);
    }
    const report = await this.registry.terminateGroup({
      groupId: procId,
      directScope: authority.directScope,
      category: authority.category,
      reason: authority.reason ?? 'process killed',
      graceMs: authority.graceMs,
    });
    this.assertStopSucceeded(report);
    return this.get(procId);
  }

  terminateScopeTree(input: { rootScope: ManagedProcessScope; categories: readonly ProcessCategory[]; reason: string; graceMs?: number }): Promise<ProcessStopReport> {
    return this.registry.terminateScopeTree(input);
  }

  terminateOwnedRoot(owner: 'runtime' | 'analyst' | 'mcp', rootScope: ManagedProcessScope, reason: string): Promise<ProcessStopReport> {
    const expected = owner === 'runtime' ? this.runtimeRootScope : owner === 'analyst' ? this.analystRootScope : this.mcpRootScope;
    if (rootScope !== expected) throw new Error(`Managed process root does not belong to component '${owner}'.`);
    const category: ProcessCategory = owner === 'runtime' ? 'runtime_card' : owner === 'analyst' ? 'operator_session' : 'service_infrastructure';
    return this.registry.terminateScopeTree({ rootScope, categories: [category], reason, graceMs: 5_000 });
  }

  closeLaunchAdmission(): void { this.registry.closeLaunchAdmission(); }

  closeScope(scope: ManagedProcessScope): void {
    this.registry.closeScope(scope);
  }

  createContainerScope(parent: ManagedProcessScope, label: string): ManagedProcessScope {
    return this.registry.createContainerScope(parent, label);
  }

  createDirectScope(parent: ManagedProcessScope, label: string, category: ProcessCategory): ManagedProcessScope {
    return this.registry.createDirectScope(parent, label, category);
  }

  list(filter?: ProcessListFilter): ProcessRecord[] {
    let records = [...this.presentations.values()].map(({ record }) => ({ ...record }));
    if (filter?.cardId) records = records.filter((record) => record.card_id === filter.cardId);
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter((record) => statuses.includes(record.status));
    }
    return records;
  }

  get(procId: string): ProcessRecord | null {
    const record = this.presentations.get(procId)?.record;
    return record ? { ...record } : null;
  }

  bindingMatches(procId: string, directScope: ManagedProcessScope, category: ProcessCategory): boolean {
    const binding = this.bindings.get(procId);
    return binding?.directScope === directScope && binding.category === category;
  }

  private launch(spec: ProcessSpawnSpec, file: string, args: readonly string[], stdio: SpawnOptions['stdio'], captureOutput: boolean, childEnv: NodeJS.ProcessEnv): InteractiveProcessLaunch {
    if (!spec.command) throw new Error('command must not be empty');
    if (!spec.ownerId || !spec.ownerKind) throw new Error('process spawn requires explicit ownerId and ownerKind.');
    const id = generateId();
    const cwd = spec.cwd ? resolve(spec.cwd) : this.projectRoot;
    const cardId = spec.cardId ?? null;
    const outputDir = cardId ? cardProcessOutputRoot(this.projectRoot, cardId, id) : nonCardProcessOutputRoot(this.projectRoot, id);
    mkdirSync(outputDir, { recursive: true });
    const stdoutPath = join(outputDir, 'stdout.log');
    const stderrPath = join(outputDir, 'stderr.log');
    let streams: ProcessPresentation['streams'] = null;
    if (captureOutput) {
      streams = { stdout: createWriteStream(stdoutPath, { flags: 'a' }), stderr: createWriteStream(stderrPath, { flags: 'a' }) };
      streams.stdout.on('error', () => {});
      streams.stderr.on('error', () => {});
    } else {
      writeFileSync(stdoutPath, '', { flag: 'a' });
      writeFileSync(stderrPath, '', { flag: 'a' });
    }
    const record: ProcessRecord = {
      id,
      card_id: cardId,
      owner_id: spec.ownerId,
      command: redactCommandForPolicy(spec.command),
      command_hash: createHash('sha256').update(this.commandHashSalt).update('\0').update(spec.command).digest('hex'),
      cwd,
      cwd_canonical: resolve(cwd),
      status: 'running',
      pid: null,
      started_at: now(),
      started_at_monotonic: nowMonotonic(),
      completed_at: null,
      exit_code: null,
      signal: null,
      terminal_reason: null,
      required_for_card_completion: cardId ? (spec.requiredForCardCompletion ?? true) : false,
      output_dir: outputDir,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      agent_session_id: spec.agentSessionId ?? null,
      goal_id: spec.goalId ?? null,
      launch_reason: spec.launchReason ?? null,
      owner_kind: spec.ownerKind,
      background_policy: spec.backgroundPolicy ?? null,
      failure_classification: null,
    };
    const presentation: ProcessPresentation = { record, leaderOutcome: null, streams, streamClose: null };
    this.presentations.set(id, presentation);
    this.bindings.set(id, { directScope: spec.directScope, category: spec.category });
    let child: ChildProcess;
    try {
      child = this.registry.launch({
        groupId: id,
        directScope: spec.directScope,
        category: spec.category,
        file,
        args,
        options: {
          cwd,
          env: childEnv,
          stdio,
        },
        onAbsent: (reason) => this.finalize(id, reason),
      });
    } catch (error) {
      this.presentations.delete(id);
      this.bindings.delete(id);
      void this.closeStreams(streams);
      throw error;
    }
    record.pid = child.pid ?? null;
    if (captureOutput && streams) {
      child.stdout?.pipe(streams.stdout);
      child.stderr?.pipe(streams.stderr);
    }
    child.once('exit', (exitCode, signalCode) => {
      presentation.leaderOutcome = {
        status: signalCode === 'SIGKILL' || signalCode === 'SIGTERM' ? 'killed' : exitCode === 0 ? 'exited' : 'failed',
        exit_code: exitCode,
        signal: signalCode ?? null,
        terminal_reason: signalCode ? 'signal' : 'exit',
      };
    });
    child.once('error', (error) => {
      if (streams) streams.stderr.write(`[process-runner] spawn error: ${error.message}\n`);
      presentation.leaderOutcome = { status: 'failed', exit_code: -1, signal: null, terminal_reason: 'spawn_error' };
    });
    return { record: { ...record }, process: child };
  }

  private finalize(procId: string, terminationReason: string | null): void {
    const presentation = this.presentations.get(procId);
    if (!presentation || presentation.record.status !== 'running') return;
    const outcome = terminationReason
      ? { status: 'killed' as const, exit_code: null, signal: 'SIGTERM', terminal_reason: 'signal' as const }
      : presentation.leaderOutcome ?? { status: 'failed' as const, exit_code: null, signal: null, terminal_reason: 'spawn_error' };
    presentation.record = { ...presentation.record, ...outcome, completed_at: now(), failure_classification: outcome.terminal_reason === 'spawn_error' ? 'spawn_error' : null };
    presentation.streamClose = this.closeStreams(presentation.streams);
    presentation.streams = null;
  }

  private closeStreams(streams: ProcessPresentation['streams']): Promise<void> {
    if (!streams) return Promise.resolve();
    return Promise.all(Object.values(streams).map((stream) => new Promise<void>((resolveClose) => {
      if (stream.destroyed) { resolveClose(); return; }
      stream.once('close', resolveClose);
      stream.end();
    }))).then(() => undefined);
  }

  private waitResult(procId: string, timedOut: boolean, started: number): ProcessWaitResult {
    const record = this.presentations.get(procId)!.record;
    return { id: procId, status: record.status, exitCode: record.exit_code ?? null, timedOut, waitDurationMs: Date.now() - started };
  }

  private assertStopSucceeded(report: ProcessStopReport): void {
    if (report.failed.length === 0) return;
    throw new Error(report.failed.map((failure) => `${failure.groupId}: ${failure.state}: ${failure.diagnostic}`).join('; '));
  }
}

export type { ManagedProcessScope, ProcessCategory, ProcessStopReport } from './managed-process-group-registry.js';
