import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimeResourceHandle } from './lifecycle.js';
import { createRuntimeLifecycleScope, type RuntimeLifecycleScope } from './lifecycle.js';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  type WriteStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic, explainLegacyStateRejection } from '../persistence/index.js';
import { redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/index.js';
import { now } from '../utils/clock.js';

export interface ProcessSpawnSpec {
  command: string;
  cardId: string;
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

export interface ProcessReconcileOptions {
  nowMonotonicMs?: number;
  maxClockSkewMs?: number;
}

export interface ProcessReconcileResult {
  matched: string[];
  lost: string[];
  skewed: string[];
}

export interface ProcessStopReport {
  attempted: string[];
  stopped: string[];
  failed: Array<{ id: string; error: string }>;
}

const PROCESSES_DIR = '.saivage-work/processes';
const RUNTIME_PROCESSES_FILE = '.saivage/runtime/processes.json';

export class ProcessRunner {
  private processRecords: Map<string, ProcessRecord> | null = null;
  private commandHashSalt: Buffer | null = null;
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly outputStreams = new Map<string, { stdout: WriteStream; stderr: WriteStream }>();
  readonly pendingStreamCloses = new Map<string, number>();
  readonly streamCloseWaiters = new Map<string, Promise<void>>();
  private scope: RuntimeLifecycleScope | null = null;
  readonly processResourceHandles = new Map<string, RuntimeResourceHandle[]>();

  constructor(readonly projectRoot: string) {}

  spawn(spec: ProcessSpawnSpec): ProcessRecord { return startProcessForRunner(this, spec); }
  wait(procId: string, timeoutMs: number = 0): Promise<ProcessWaitResult> { return waitProcessForRunner(this, procId, timeoutMs); }
  kill(procId: string, reason = 'process killed', options: { graceMs?: number } = {}): Promise<ProcessRecord | null> { return stopProcess(this, procId, reason, options.graceMs ?? 5000); }
  stopByOwner(ownerId: string, reason: string, options: { graceMs?: number } = {}): Promise<ProcessStopReport> { return stopMatching(this, (record) => record.owner_id === ownerId, reason, options.graceMs ?? 5000); }
  stopRuntimeOwned(reason: string, options: { graceMs?: number } = {}): Promise<ProcessStopReport> { return stopMatching(this, (record) => record.owner_kind !== 'operator', reason, options.graceMs ?? 5000); }
  list(filter?: ProcessListFilter): ProcessRecord[] { return listProcessesForRunner(this, filter); }
  get(procId: string): ProcessRecord | null { return getProcessForRunner(this, procId); }
  reconcile(options: ProcessReconcileOptions = {}): Promise<ProcessReconcileResult> { return reconcileProcessRecordsForRunner(this, options); }

  getTransientRegistry(): Map<string, ProcessRecord> {
    if (!this.processRecords) this.processRecords = durableRegistry(this.projectRoot);
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

function runtimeProcessesPath(projectRoot: string): string {
  return join(projectRoot, RUNTIME_PROCESSES_FILE);
}

function processesDir(projectRoot: string): string {
  return join(projectRoot, PROCESSES_DIR);
}

function processDir(projectRoot: string, procId: string): string {
  return join(processesDir(projectRoot), procId);
}

function commandHash(service: ProcessRunner, command: string): string {
  return createHash('sha256').update(service.getCommandHashSalt()).update('\0').update(command).digest('hex');
}

function durableRegistry(projectRoot: string): Map<string, ProcessRecord> {
  const registry = new Map<string, ProcessRecord>();
  const path = runtimeProcessesPath(projectRoot);
  if (!existsSync(path)) return registry;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    explainLegacyStateRejection(projectRoot, 'ProcessRecord registry', error instanceof Error ? error.message : String(error));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    explainLegacyStateRejection(projectRoot, 'ProcessRecord registry', 'registry must be an object with schema_version and records');
  }
  const body = parsed as { schema_version?: unknown; records?: unknown };
  if (body.schema_version !== 1 || !Array.isArray(body.records)) {
    explainLegacyStateRejection(projectRoot, 'ProcessRecord registry', 'unsupported ProcessRecord registry shape');
  }
  for (const record of body.records as ProcessRecord[]) {
    registry.set(record.id, record);
  }
  return registry;
}

function persistRegistry(projectRoot: string, registry: Map<string, ProcessRecord>): void {
  writeFileAtomic(runtimeProcessesPath(projectRoot), JSON.stringify({ schema_version: 1, records: Array.from(registry.values()) }, null, 2) + '\n');
}

function transientRegistry(service: ProcessRunner): Map<string, ProcessRecord> {
  return service.getTransientRegistry();
}

function resolveStatus(proc: ChildProcess): ProcessStatus {
  if (proc.signalCode !== null) {
    return proc.signalCode === 'SIGKILL' || proc.signalCode === 'SIGTERM'
      ? 'killed'
      : 'failed';
  }
  if (proc.exitCode !== null) {
    return proc.exitCode === 0 ? 'exited' : 'failed';
  }
  return 'running';
}

function resolveExitCode(proc: ChildProcess): number | null {
  if (proc.exitCode !== null) return proc.exitCode;
  if (proc.signalCode !== null) return null;
  return null;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupId(record: ProcessRecord): number | null {
  const pgid = record.process_group_id ?? record.pid ?? null;
  return pgid && pgid > 0 ? pgid : null;
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
    return code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return true;
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
  persistRegistry(service.projectRoot, registry);
}

function ensureProcessDir(projectRoot: string, procId: string): string {
  const dir = processDir(projectRoot, procId);
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
  if (!options.ownerId || !options.ownerKind || !options.cardId) {
    throw new Error('process spawn requires explicit ownerId, ownerKind, and cardId.');
  }

  const id = generateId();
  const projectRoot = service.projectRoot;
  const cwd = options.cwd ? resolve(options.cwd) : projectRoot;
  const dir = ensureProcessDir(projectRoot, id);

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
  service.outputStreams.set(id, streams);
  const scope = processScope(service);
  rememberProcessResource(service, id, scope.registerChildProcess(child, 'detach', `child:${id}`, `child:${id}`));
  rememberProcessResource(service, id, scope.registerStream(streams.stdout, `stdout:${id}`, `stream:stdout:${id}`));
  rememberProcessResource(service, id, scope.registerStream(streams.stderr, `stderr:${id}`, `stream:stderr:${id}`));

  const record: ProcessRecord = {
    id,
    card_id: options.cardId,
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
    required_for_card_completion: options.requiredForCardCompletion ?? true,
    output_dir: dir,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    agent_session_id: options.agentSessionId ?? null,
    goal_id: options.goalId ?? null,
    launch_reason: options.launchReason ?? null,
    owner_kind: options.ownerKind,
    background_policy: options.backgroundPolicy ?? null,
    process_group_id: child.pid ?? null,
    failure_classification: null,
  };

  upsertRegistryRecord(service, record);

  child.on('exit', (exitCode, signalCode) => {
    const finalStatus: ProcessStatus =
      signalCode === 'SIGKILL' || signalCode === 'SIGTERM'
        ? 'killed'
        : exitCode === 0
          ? 'exited'
          : 'failed';

    const latest = getProcessForRunner(service, id) ?? record;
    const updatedRecord: ProcessRecord = {
      ...latest,
      status: finalStatus,
      exit_code: exitCode,
      signal: signalCode ?? null,
      terminal_reason: signalCode ? 'signal' : 'exit',
      completed_at: now(),
    };

    try {
      upsertRegistryRecord(service, updatedRecord);
    } catch { void 0; }

    const pending = service.pendingStreamCloses.get(id);
    if (pending !== undefined && pending <= 0) {
      finalizeProcess(service, id);
    }

    const cleanupTimer = setTimeout(() => {
      if (service.activeProcesses.has(id) || service.outputStreams.has(id)) {
        finalizeProcess(service, id);
      }
      unregisterProcessResource(service, id, cleanupTimerHandle);
    }, 5000);
    cleanupTimer.unref();
    const cleanupTimerHandle = rememberProcessResource(service, id, processScope(service).registerTimer(cleanupTimer, `cleanup-timer:${id}`, `timer:cleanup:${id}`));
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
    finalizeProcess(service, procId);
  } else {
    service.pendingStreamCloses.set(procId, remaining);
  }
}

function waitProcessForRunner(
  service: ProcessRunner,
  procId: string,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  return new Promise((resolve) => {
    const waitStart = Date.now();
    const child = service.activeProcesses.get(procId);

    if (!child) {
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

      if (record.status === 'running') {
        throw new Error(`Cannot wait for unattached running process ${procId}. Reconcile or stop the process scope first.`);
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

    const currentStatus = resolveStatus(child);
    if (currentStatus !== 'running') {
      void waitForDurableOutput(service, procId).finally(() => {
        resolve({
          id: procId,
          status: currentStatus,
          exitCode: resolveExitCode(child),
          timedOut: false,
          waitDurationMs: Date.now() - waitStart,
        });
      });
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    let timerHandle: RuntimeResourceHandle | null = null;
    let exitHandle: RuntimeResourceHandle | null = null;
    let closeHandle: RuntimeResourceHandle | null = null;
    let errorHandle: RuntimeResourceHandle | null = null;
    let resolved = false;

    const doResolve = (timedOut: boolean) => {
      if (resolved) return;
      resolved = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (timerHandle) { unregisterProcessResource(service, procId, timerHandle); timerHandle = null; }
      if (exitHandle) { unregisterProcessResource(service, procId, exitHandle); exitHandle = null; }
      if (closeHandle) { unregisterProcessResource(service, procId, closeHandle); closeHandle = null; }
      if (errorHandle) { unregisterProcessResource(service, procId, errorHandle); errorHandle = null; }
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);

      if (timedOut) {
        resolve({
          id: procId,
          status: 'running',
          exitCode: null,
          timedOut: true,
          waitDurationMs: Date.now() - waitStart,
        });
      } else {
        void waitForDurableOutput(service, procId).finally(() => {
          const latest = getProcessForRunner(service, procId);
          resolve({
            id: procId,
            status: latest?.status ?? resolveStatus(child),
            exitCode: latest?.exit_code ?? resolveExitCode(child),
            timedOut: false,
            waitDurationMs: Date.now() - waitStart,
          });
        });
      }
    };

    const onExit = () => {};
    const onClose = () => doResolve(false);
    const onError = () => doResolve(false);

    child.on('exit', onExit);
    child.on('close', onClose);
    child.on('error', onError);
    const scope = processScope(service);
    exitHandle = rememberProcessResource(service, procId, scope.registerListener(child, 'exit', onExit as (...args: unknown[]) => void, `wait-exit:${procId}`));
    closeHandle = rememberProcessResource(service, procId, scope.registerListener(child, 'close', onClose as (...args: unknown[]) => void, `wait-close:${procId}`));
    errorHandle = rememberProcessResource(service, procId, scope.registerListener(child, 'error', onError as (...args: unknown[]) => void, `wait-error:${procId}`));

    if (timeoutMs > 0) {
      timer = setTimeout(() => doResolve(true), timeoutMs);
      timerHandle = rememberProcessResource(service, procId, scope.registerTimer(timer, `wait-timeout:${procId}`));
    }
  });
}

async function stopProcess(service: ProcessRunner, procId: string, reason: string, graceMs: number): Promise<ProcessRecord | null> {
  const record = getProcessForRunner(service, procId);
  if (!record) return null;
  if (record.status !== 'running') return record;
  const child = service.activeProcesses.get(procId);
  if (child && resolveStatus(child) === 'running') {
    signalProcessTree(child, 'SIGTERM');
    const waitResult = await waitProcessForRunner(service, procId, graceMs);
    if (waitResult.timedOut || waitResult.status === 'running') {
      signalProcessTree(child, 'SIGKILL');
      await waitProcessForRunner(service, procId, 2000);
    }
    const latest = getProcessForRunner(service, procId);
    if (latest && latest.status !== 'running') return latest;
    return latest;
  }

  return terminateUnattachedRunning(service, record, reason, graceMs);
}

function markLost(service: ProcessRunner, record: ProcessRecord, reason: string): ProcessRecord {
  const updated: ProcessRecord = {
    ...record,
    status: 'failed',
    completed_at: record.completed_at ?? now(),
    exit_code: record.exit_code ?? null,
    signal: record.signal ?? null,
    terminal_reason: 'lost',
    failure_classification: 'lost',
    reattach_error: reason,
  };
  upsertRegistryRecord(service, updated);
  return updated;
}

function markKilled(service: ProcessRunner, record: ProcessRecord, signal: NodeJS.Signals, reason: string): ProcessRecord {
  const updated: ProcessRecord = {
    ...record,
    status: 'killed',
    completed_at: now(),
    exit_code: record.exit_code ?? null,
    signal,
    terminal_reason: 'kill_unattached',
    failure_classification: record.failure_classification ?? null,
    reattach_error: reason,
  };
  upsertRegistryRecord(service, updated);
  return updated;
}

async function terminateUnattachedRunning(service: ProcessRunner, record: ProcessRecord, reason: string, graceMs: number): Promise<ProcessRecord> {
  const pgid = processGroupId(record);
  if (!pgid) return markLost(service, record, `${reason}: missing process group id`);

  signalProcessGroup(pgid, 'SIGTERM');
  if (await waitForProcessGroupExit(pgid, graceMs)) {
    return markKilled(service, record, 'SIGTERM', reason);
  }

  signalProcessGroup(pgid, 'SIGKILL');
  if (await waitForProcessGroupExit(pgid, 2000)) {
    return markKilled(service, record, 'SIGKILL', reason);
  }

  return markLost(service, record, `${reason}: process group still alive after SIGKILL`);
}

async function reconcileOwnedRecord(service: ProcessRunner, record: ProcessRecord): Promise<'killed' | 'lost'> {
  const updated = await terminateUnattachedRunning(service, record, 'startup process reconciliation', 5000);
  return updated.status === 'killed' ? 'killed' : 'lost';
}

async function reconcileProcessRecordsForRunner(service: ProcessRunner, options: ProcessReconcileOptions = {}): Promise<ProcessReconcileResult> {
  const result: ProcessReconcileResult = { matched: [], lost: [], skewed: [] };
  const records = Array.from(loadRegistryForRunner(service).values()).filter((record) => record.status === 'running');
  const currentMonotonic = options.nowMonotonicMs ?? nowMonotonic();
  const maxClockSkewMs = options.maxClockSkewMs ?? 60_000;

  for (const record of records) {
    if (record.started_at_monotonic > currentMonotonic + maxClockSkewMs) {
      result.skewed.push(record.id);
      markLost(service, record, 'started_at_monotonic is in the future beyond clock-skew tolerance');
      result.lost.push(record.id);
      continue;
    }

    const pgid = processGroupId(record);
    if (!pgid || !isProcessGroupAlive(pgid)) {
      markLost(service, record, 'startup process group is not running');
      result.lost.push(record.id);
      continue;
    }

    if (record.owner_kind === 'operator') {
      result.matched.push(record.id);
      continue;
    }

    const status = await reconcileOwnedRecord(service, record);
    if (status === 'lost') result.lost.push(record.id);
  }
  return result;
}

function listProcessesForRunner(
  service: ProcessRunner,
  filter?: ProcessListFilter,
): ProcessRecord[] {
  const registry = loadRegistryForRunner(service);
  const records = Array.from(registry.values());

  for (const [procId, child] of service.activeProcesses) {
    const memStatus = resolveStatus(child);
    if (memStatus !== 'running') continue;

    const existing = registry.get(procId);
    if (existing) {
      const idx = records.findIndex((r) => r.id === procId);
      if (idx >= 0) {
        records[idx] = { ...existing, status: 'running', pid: child.pid ?? existing.pid };
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
    const child = service.activeProcesses.get(record.id);
    if (child && resolveStatus(child) === 'running') {
      signalProcessTree(child, 'SIGTERM');
      continue;
    }
    const pgid = processGroupId(record);
    if (pgid) signalProcessGroup(pgid, 'SIGTERM');
  }

  await Promise.all(records.map(async (record) => {
    try {
      const child = service.activeProcesses.get(record.id);
      if (child && resolveStatus(child) === 'running') {
        await waitProcessForRunner(service, record.id, graceMs);
        return;
      }
      const pgid = processGroupId(record);
      if (pgid) await waitForProcessGroupExit(pgid, graceMs);
    } catch (error) {
      report.failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  for (const record of records) {
    const latest = getProcessForRunner(service, record.id) ?? record;
    if (latest.status !== 'running') continue;
    const child = service.activeProcesses.get(record.id);
    if (child && resolveStatus(child) === 'running') {
      signalProcessTree(child, 'SIGKILL');
      continue;
    }
    const pgid = processGroupId(latest);
    if (pgid && isProcessGroupAlive(pgid)) signalProcessGroup(pgid, 'SIGKILL');
  }

  await Promise.all(records.map(async (record) => {
    if (report.failed.some((item) => item.id === record.id)) return;
    try {
      const child = service.activeProcesses.get(record.id);
      if (child && resolveStatus(child) === 'running') {
        await waitProcessForRunner(service, record.id, 2000);
      } else {
        const latest = getProcessForRunner(service, record.id) ?? record;
        const pgid = processGroupId(latest);
        if (pgid && !isProcessGroupAlive(pgid)) {
          markKilled(service, latest, 'SIGTERM', reason);
        } else if (pgid && await waitForProcessGroupExit(pgid, 2000)) {
          markKilled(service, latest, 'SIGKILL', reason);
        } else if (latest.status === 'running') {
          markLost(service, latest, `${reason}: process group still running after SIGKILL`);
        }
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
