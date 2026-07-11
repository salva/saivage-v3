import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimeResourceHandle } from './lifecycle.js';
import { createRuntimeLifecycleScope, type RuntimeLifecycleScope } from './lifecycle.js';
import {
  mkdirSync,
  createWriteStream,
  type WriteStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/index.js';
import { now } from '../utils/clock.js';
import { cardProcessOutputRoot, nonCardProcessOutputRoot } from '../persistence/layout.js';
import { processGroupAlive, processGroupId, signalProcessGroup } from './posix-process-group.js';

interface ProcessGroupControl {
  pgid: number;
  leaderOutcome: Pick<ProcessRecord, 'status' | 'exit_code' | 'signal' | 'terminal_reason'> | null;
  terminationReason: string | null;
  settlement: Promise<void>;
}

export interface ProcessSpawnSpec {
  command: string;
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

export interface ProcessStopReport {
  attempted: string[];
  stopped: string[];
  failed: Array<{ id: string; error: string }>;
}

export class ProcessRunner {
  private processRecords: Map<string, ProcessRecord> | null = null;
  private commandHashSalt: Buffer | null = null;
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly outputStreams = new Map<string, { stdout: WriteStream; stderr: WriteStream }>();
  readonly pendingStreamCloses = new Map<string, number>();
  readonly streamCloseWaiters = new Map<string, Promise<void>>();
  private scope: RuntimeLifecycleScope | null = null;
  readonly processResourceHandles = new Map<string, RuntimeResourceHandle[]>();
  readonly processGroups = new Map<string, ProcessGroupControl>();

  constructor(readonly projectRoot: string) {}

  spawn(spec: ProcessSpawnSpec): ProcessRecord { return startProcessForRunner(this, spec); }
  wait(procId: string, timeoutMs: number = 0): Promise<ProcessWaitResult> { return waitProcessForRunner(this, procId, timeoutMs); }
  kill(procId: string, reason = 'process killed', options: { graceMs?: number } = {}): Promise<ProcessRecord | null> { return stopProcess(this, procId, reason, options.graceMs ?? 5000); }
  stopByOwner(ownerId: string, reason: string, options: { graceMs?: number } = {}): Promise<ProcessStopReport> { return stopMatching(this, (record) => record.owner_id === ownerId, reason, options.graceMs ?? 5000); }
  stopRuntimeOwned(reason: string, options: { graceMs?: number } = {}): Promise<ProcessStopReport> { return stopMatching(this, (record) => record.owner_kind !== 'operator', reason, options.graceMs ?? 5000); }
  list(filter?: ProcessListFilter): ProcessRecord[] { return listProcessesForRunner(this, filter); }
  get(procId: string): ProcessRecord | null { return getProcessForRunner(this, procId); }

  getTransientRegistry(): Map<string, ProcessRecord> {
    if (!this.processRecords) this.processRecords = new Map();
    return this.processRecords;
  }

  setTransientRegistry(records: Map<string, ProcessRecord>): void { this.processRecords = records; }

  getCommandHashSalt(): Buffer {
    if (!this.commandHashSalt) this.commandHashSalt = randomBytes(32);
    return this.commandHashSalt;
  }

  getRuntimeScope(): RuntimeLifecycleScope | null { return this.scope; }
  setRuntimeScope(scope: RuntimeLifecycleScope | null): void { this.scope = scope; }
}

function processScope(service: ProcessRunner): RuntimeLifecycleScope {
  let scope = service.getRuntimeScope();
  if (!scope || scope.isDisposed) {
    scope = createRuntimeLifecycleScope(`process-runtime:${service.projectRoot}`);
    service.setRuntimeScope(scope);
  }
  return scope;
}

function rememberProcessResource(service: ProcessRunner, procId: string, handle: RuntimeResourceHandle): RuntimeResourceHandle {
  let handles = service.processResourceHandles.get(procId);
  if (!handles) {
    handles = [];
    service.processResourceHandles.set(procId, handles);
  }
  handles.push(handle);
  return handle;
}

function unregisterProcessResource(service: ProcessRunner, procId: string, handle: RuntimeResourceHandle): void {
  handle.unregister();
  const handles = service.processResourceHandles.get(procId);
  if (!handles) return;
  const idx = handles.indexOf(handle);
  if (idx >= 0) handles.splice(idx, 1);
  if (handles.length === 0) service.processResourceHandles.delete(procId);
}

function unregisterAllProcessResources(service: ProcessRunner, procId: string): void {
  const handles = service.processResourceHandles.get(procId) ?? [];
  for (const handle of handles.splice(0)) handle.unregister();
  service.processResourceHandles.delete(procId);
}

function generateId(): string {
  return `proc-${randomBytes(6).toString('hex')}`;
}

function nowMonotonic(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

function processDir(projectRoot: string, procId: string, cardId?: string | null): string {
  return cardId ? cardProcessOutputRoot(projectRoot, cardId, procId) : nonCardProcessOutputRoot(projectRoot, procId);
}

function commandHash(service: ProcessRunner, command: string): string {
  return createHash('sha256').update(service.getCommandHashSalt()).update('\0').update(command).digest('hex');
}

function transientRegistry(service: ProcessRunner): Map<string, ProcessRecord> {
  return service.getTransientRegistry();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDurableOutput(service: ProcessRunner, procId: string): Promise<void> {
  const waiter = service.streamCloseWaiters.get(procId);
  if (!waiter) return;
  try {
    await waiter;
  } catch { void 0; 
  }
}

function loadRegistryForRunner(service: ProcessRunner): Map<string, ProcessRecord> {
  return transientRegistry(service);
}

function upsertRegistryRecord(service: ProcessRunner, record: ProcessRecord): void {
  const registry = transientRegistry(service);
  registry.set(record.id, record);
}

function ensureProcessDir(projectRoot: string, procId: string, cardId?: string | null): string {
  const dir = processDir(projectRoot, procId, cardId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function openOutputStreams(dir: string): {
  stdout: WriteStream;
  stderr: WriteStream;
} {
  const stdout = createWriteStream(join(dir, 'stdout.log'), { flags: 'a' });
  const stderr = createWriteStream(join(dir, 'stderr.log'), { flags: 'a' });

  for (const stream of [stdout, stderr]) {
    stream.on('error', () => {});
  }

  return { stdout, stderr };
}

function closeAllStreams(service: ProcessRunner, procId: string): Promise<void> {
  const streams = service.outputStreams.get(procId);
  if (!streams) return Promise.resolve();

  service.outputStreams.delete(procId);

  const closings: Promise<void>[] = [];
  for (const stream of Object.values(streams)) {
    if (stream.destroyed) continue;
    closings.push(
      new Promise<void>((resolve) => {
        stream.on('close', () => resolve());
        const safety = setTimeout(() => resolve(), 5000);
        safety.unref();
        stream.on('close', () => clearTimeout(safety));
        try {
          stream.end();
        } catch {
          resolve();
        }
      }),
    );
  }

  return Promise.all(closings).then(() => undefined);
}

function finalizeProcess(service: ProcessRunner, procId: string): void {
  const child = service.activeProcesses.get(procId);
  if (child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }
  unregisterAllProcessResources(service, procId);
  const closePromise = closeAllStreams(service, procId).finally(() => {
    service.streamCloseWaiters.delete(procId);
  });
  service.streamCloseWaiters.set(procId, closePromise);
  service.activeProcesses.delete(procId);
  service.pendingStreamCloses.delete(procId);
}

function startProcessForRunner(service: ProcessRunner, spec: ProcessSpawnSpec): ProcessRecord {
  const command = spec.command;
  const options = spec;
  if (!command || command.length === 0) {
    throw new Error('command must not be empty');
  }
  if (!options.ownerId || !options.ownerKind) {
    throw new Error('process spawn requires explicit ownerId and ownerKind.');
  }

  const id = generateId();
  const projectRoot = service.projectRoot;
  const cwd = options.cwd ? resolve(options.cwd) : projectRoot;
  const cardId = options.cardId ?? null;
  const dir = ensureProcessDir(projectRoot, id, cardId);

  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');

  const streams = openOutputStreams(dir);
  service.pendingStreamCloses.set(id, 2);

  const childEnv = {
    ...sanitizedCommandEnv(),
    PROJECT_ROOT: projectRoot,
    SAIVAGE_ROOT: projectRoot,
    ...options.env,
  };

  const child = spawn('sh', ['-c', command], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  if (child.stdout) {
    child.stdout.pipe(streams.stdout);
    child.stdout.on('end', () => onStreamEnd(service, id));
  }

  if (child.stderr) {
    child.stderr.pipe(streams.stderr);
    child.stderr.on('end', () => onStreamEnd(service, id));
  }

  if (!child.stdout && !child.stderr) {
    service.pendingStreamCloses.set(id, 0);
  }

  service.activeProcesses.set(id, child);
  const pgid = processGroupId(child);
  service.outputStreams.set(id, streams);
  const scope = processScope(service);
  rememberProcessResource(service, id, scope.registerChildProcess(child, 'kill', `child:${id}`, `child:${id}`));
  rememberProcessResource(service, id, scope.registerStream(streams.stdout, `stdout:${id}`, `stream:stdout:${id}`));
  rememberProcessResource(service, id, scope.registerStream(streams.stderr, `stderr:${id}`, `stream:stderr:${id}`));

  const record: ProcessRecord = {
    id,
    card_id: cardId,
    owner_id: options.ownerId,
    command: redactCommandForPolicy(command),
    command_hash: commandHash(service, command),
    cwd,
    cwd_canonical: resolve(cwd),
    status: 'running',
    pid: child.pid ?? null,
    started_at: now(),
    started_at_monotonic: nowMonotonic(),
    completed_at: null,
    exit_code: null,
    signal: null,
    terminal_reason: null,
    required_for_card_completion: cardId ? (options.requiredForCardCompletion ?? true) : false,
    output_dir: dir,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    agent_session_id: options.agentSessionId ?? null,
    goal_id: options.goalId ?? null,
    launch_reason: options.launchReason ?? null,
    owner_kind: options.ownerKind,
    background_policy: options.backgroundPolicy ?? null,
    failure_classification: null,
  };

  upsertRegistryRecord(service, record);

  const control: ProcessGroupControl = {
    pgid,
    leaderOutcome: null,
    terminationReason: null,
    settlement: Promise.resolve(),
  };
  control.settlement = settleProcessGroup(service, id, control);
  service.processGroups.set(id, control);

  child.on('exit', (exitCode, signalCode) => {
    const finalStatus: ProcessStatus =
      signalCode === 'SIGKILL' || signalCode === 'SIGTERM'
        ? 'killed'
        : exitCode === 0
          ? 'exited'
          : 'failed';

    control.leaderOutcome = {
      status: finalStatus,
      exit_code: exitCode,
      signal: signalCode ?? null,
      terminal_reason: signalCode ? 'signal' : 'exit',
    };
    service.activeProcesses.delete(id);
  });

  child.on('error', (err) => {
    const errorMsg = `[process-runner] spawn error: ${err.message}\n`;
    try {
      streams.stderr.write(errorMsg);
    } catch { void 0; }

    const updatedRecord: ProcessRecord = {
      ...record,
      status: 'failed',
      exit_code: -1,
      signal: null,
      terminal_reason: 'spawn_error',
      failure_classification: 'spawn_error',
      completed_at: now(),
    };

    service.processGroups.delete(id);
    finalizeProcess(service, id);

    try {
      upsertRegistryRecord(service, updatedRecord);
    } catch { void 0; }
  });

  return record;
}

function onStreamEnd(service: ProcessRunner, procId: string): void {
  const current = service.pendingStreamCloses.get(procId);
  if (current === undefined) return;

  const remaining = current - 1;
  if (remaining <= 0) {
    service.pendingStreamCloses.set(procId, 0);
  } else {
    service.pendingStreamCloses.set(procId, remaining);
  }
}

async function settleProcessGroup(service: ProcessRunner, procId: string, control: ProcessGroupControl): Promise<void> {
  while (processGroupAlive(control.pgid)) await sleep(50);
  const current = getProcessForRunner(service, procId);
  if (!current) return;
  const outcome: Pick<ProcessRecord, 'status' | 'exit_code' | 'signal' | 'terminal_reason'> = control.terminationReason
    ? { status: 'killed', exit_code: null, signal: 'SIGTERM', terminal_reason: 'signal' }
    : control.leaderOutcome ?? { status: 'failed', exit_code: null, signal: null, terminal_reason: 'spawn_error' };
  upsertRegistryRecord(service, { ...current, ...outcome, completed_at: now() });
  service.processGroups.delete(procId);
  finalizeProcess(service, procId);
}

function waitProcessForRunner(
  service: ProcessRunner,
  procId: string,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  return new Promise((resolve) => {
    const waitStart = Date.now();
    const control = service.processGroups.get(procId);
    if (!control) {
      const registry = loadRegistryForRunner(service);
      const record = registry.get(procId);
      if (!record) {
        resolve({
          id: procId,
          status: 'failed',
          exitCode: null,
          timedOut: false,
          waitDurationMs: Date.now() - waitStart,
        });
        return;
      }

      void waitForDurableOutput(service, procId).finally(() => {
        resolve({
          id: procId,
          status: record.status,
          exitCode: record.exit_code ?? null,
          timedOut: false,
          waitDurationMs: Date.now() - waitStart,
        });
      });
      return;
    }

    if (timeoutMs === 0) {
      if (processGroupAlive(control.pgid)) {
        resolve({ id: procId, status: 'running', exitCode: null, timedOut: false, waitDurationMs: Date.now() - waitStart });
        return;
      }
      void control.settlement.then(async () => {
        await waitForDurableOutput(service, procId);
        const latest = getProcessForRunner(service, procId)!;
        resolve({ id: procId, status: latest.status, exitCode: latest.exit_code ?? null, timedOut: false, waitDurationMs: Date.now() - waitStart });
      });
      return;
    }
    const timer = sleep(timeoutMs).then(() => 'timeout' as const);
    Promise.race([control.settlement.then(() => 'settled' as const), timer]).then(async (result) => {
      if (result === 'timeout' && service.processGroups.has(procId)) {
        resolve({ id: procId, status: 'running', exitCode: null, timedOut: true, waitDurationMs: Date.now() - waitStart });
        return;
      }
      await waitForDurableOutput(service, procId);
      const latest = getProcessForRunner(service, procId)!;
      resolve({ id: procId, status: latest.status, exitCode: latest.exit_code ?? null, timedOut: false, waitDurationMs: Date.now() - waitStart });
    });
  });
}

async function stopProcess(service: ProcessRunner, procId: string, reason: string, graceMs: number): Promise<ProcessRecord | null> {
  const record = getProcessForRunner(service, procId);
  if (!record) return null;
  if (record.status !== 'running') return record;
  const control = service.processGroups.get(procId);
  if (control) {
    control.terminationReason = reason;
    signalProcessGroup(control.pgid, 'SIGTERM');
    const waitResult = await waitProcessForRunner(service, procId, graceMs);
    if (waitResult.timedOut || waitResult.status === 'running') {
      signalProcessGroup(control.pgid, 'SIGKILL');
      await waitProcessForRunner(service, procId, 2000);
    }
    const latest = getProcessForRunner(service, procId);
    if (latest && latest.status !== 'running') return latest;
    return latest;
  }

  return record;
}

function listProcessesForRunner(
  service: ProcessRunner,
  filter?: ProcessListFilter,
): ProcessRecord[] {
  const registry = loadRegistryForRunner(service);
  const records = Array.from(registry.values());

  for (const [procId] of service.processGroups) {

    const existing = registry.get(procId);
    if (existing) {
      const idx = records.findIndex((r) => r.id === procId);
      if (idx >= 0) {
        records[idx] = { ...existing, status: 'running' };
      }
    }
  }

  let filtered = records;
  if (filter?.cardId) {
    filtered = filtered.filter((r) => r.card_id === filter.cardId);
  }
  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    filtered = filtered.filter((r) => statuses.includes(r.status));
  }

  return filtered;
}

function getProcessForRunner(
  service: ProcessRunner,
  procId: string,
): ProcessRecord | null {
  const registry = loadRegistryForRunner(service);
  return registry.get(procId) ?? null;
}

async function stopMatching(service: ProcessRunner, predicate: (record: ProcessRecord) => boolean, reason: string, graceMs: number): Promise<ProcessStopReport> {
  const records = listProcessesForRunner(service, { status: 'running' }).filter(predicate);
  const attempted = records.map((record) => record.id);
  const report: ProcessStopReport = { attempted, stopped: [], failed: [] };

  for (const record of records) {
    const control = service.processGroups.get(record.id);
    if (control) {
      control.terminationReason = reason;
      signalProcessGroup(control.pgid, 'SIGTERM');
      continue;
    }
    report.failed.push({ id: record.id, error: 'running process has no live child handle' });
  }

  await Promise.all(records.map(async (record) => {
    try {
      if (service.processGroups.has(record.id)) {
        await waitProcessForRunner(service, record.id, graceMs);
      }
    } catch (error) {
      report.failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  for (const record of records) {
    const latest = getProcessForRunner(service, record.id) ?? record;
    if (latest.status !== 'running') continue;
    const control = service.processGroups.get(record.id);
    if (control) {
      signalProcessGroup(control.pgid, 'SIGKILL');
    }
  }

  await Promise.all(records.map(async (record) => {
    if (report.failed.some((item) => item.id === record.id)) return;
    try {
      if (service.processGroups.has(record.id)) {
        await waitProcessForRunner(service, record.id, 2000);
      }

      await waitForDurableOutput(service, record.id);
      const finalRecord = getProcessForRunner(service, record.id);
      if (finalRecord && finalRecord.status !== 'running') report.stopped.push(record.id);
      else report.failed.push({ id: record.id, error: 'process still running after termination attempt' });
    } catch (error) {
      report.failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  return report;
}
