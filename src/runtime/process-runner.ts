import { spawn, type ChildProcess } from 'node:child_process';
import type { RuntimeDisposeReportEntry, RuntimeLifecycleSnapshot, RuntimeResourceHandle } from './lifecycle.js';
import { createRuntimeLifecycleScope, type RuntimeLifecycleScope } from './lifecycle.js';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  type WriteStream,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic, explainLegacyStateRejection } from '../persistence/index.js';
import { redactOperatorErrorMessage } from '../workspace/index.js';
import { redactCommandForPolicy, sanitizedCommandEnv } from './command-policy.js';
import { EventLogger } from '../observability/index.js';
import { queueNotification } from '../notifications/index.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/index.js';

export interface ProcessStartOptions {
  cardId: string;
  cwd?: string;
  env?: Record<string, string>;
  requiredForCardCompletion?: boolean;
  agentSessionId?: string;
  goalId?: string;
  launchReason?: string;
  ownerKind?: 'agent' | 'operator' | 'runtime';
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

export interface ProcessTerminalNote {
  route: 'planner';
  kind: 'process_terminal';
  process_id: string;
  card_id: string;
  goal_id: string | null;
  status: ProcessStatus;
  exit_code: number | null;
  signal: string | null;
  classification?: string | null;
}

export type ProcessTerminalSink = (note: ProcessTerminalNote) => void;

export interface ProcessReconcileOptions {
  nowMonotonicMs?: number;
  maxClockSkewMs?: number;
  probe?: (record: ProcessRecord) => { running: boolean; pid?: number | null; started_at_monotonic?: number | null };
  reattach?: (record: ProcessRecord) => boolean;
}

export interface ProcessReconcileResult {
  matched: string[];
  lost: string[];
  skewed: string[];
}

const PROCESSES_DIR = '.saivage-work/processes';
const RUNTIME_PROCESSES_FILE = '.saivage/runtime/processes.json';

export class ProcessRunnerService {
  private processRecords: Map<string, ProcessRecord> | null = null;
  private commandHashSalt: Buffer | null = null;
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly outputStreams = new Map<string, { stdout: WriteStream; stderr: WriteStream; combined: WriteStream }>();
  readonly pendingStreamCloses = new Map<string, number>();
  readonly streamCloseWaiters = new Map<string, Promise<void>>();
  readonly terminalSinks = new Set<ProcessTerminalSink>();
  terminalPaused = false;
  readonly bufferedTerminalNotes = new Map<string, ProcessTerminalNote>();
  readonly deliveredTerminalNotes = new Set<string>();
  private scope: RuntimeLifecycleScope | null = null;
  readonly processResourceHandles = new Map<string, RuntimeResourceHandle[]>();

  constructor(readonly projectRoot: string) {}

  processScope(): RuntimeLifecycleScope { return processScope(this); }
  commandHash(command: string): string { return commandHash(this, command); }
  loadRegistry(): Map<string, ProcessRecord> { return loadRegistryForService(this); }
  saveRegistry(records: ProcessRecord[]): void { saveRegistryForService(this, records); }
  registerProcessTerminalSink(sink: ProcessTerminalSink): () => void { return registerProcessTerminalSinkForService(this, sink); }
  setProcessTerminalBuffering(paused: boolean): void { setProcessTerminalBufferingForService(this, paused); }
  startProcess(command: string, options: ProcessStartOptions): ProcessRecord { return startProcessForService(this, command, options); }
  waitProcess(procId: string, timeoutMs: number = 0): Promise<ProcessWaitResult> { return waitProcessForService(this, procId, timeoutMs); }
  killProcess(procId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessRecord | null> { return killProcessForService(this, procId, signal); }
  async startAndWait(command: string, options: ProcessStartOptions, timeoutMs: number = 0): Promise<ProcessWaitResult> { return startAndWaitForService(this, command, options, timeoutMs); }
  tailOutput(procId: string, lines: number = 50): string { return tailOutputForService(this, procId, lines); }
  reconcileProcessRecords(options: ProcessReconcileOptions = {}): ProcessReconcileResult { return reconcileProcessRecordsForService(this, options); }
  listProcesses(filter?: ProcessListFilter): ProcessRecord[] { return listProcessesForService(this, filter); }
  getProcess(procId: string): ProcessRecord | null { return getProcessForService(this, procId); }
  cleanupProcessOutput(procId: string): boolean { return cleanupProcessOutputForService(this, procId); }
  cleanupAllCompleted(): number { return cleanupAllCompletedForService(this); }
  stopAllRunningForRuntimeShutdown(): Promise<string[]> { return stopAllRunningForRuntimeShutdownForService(this); }
  snapshotProcessRuntimeScope(): RuntimeLifecycleSnapshot { return this.processScope().snapshot(); }
  disposeProcessRuntimeScope(): Promise<RuntimeDisposeReportEntry[]> { return disposeProcessRuntimeScopeForService(this); }
  isProcessLiveAttached(procId: string): boolean { const child = this.activeProcesses.get(procId); return Boolean(child && resolveStatus(child) === 'running'); }

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

const processRunnerServicesByRoot = new Map<string, ProcessRunnerService>();

export function serviceFor(projectRoot: string): ProcessRunnerService {
  const key = resolve(projectRoot);
  let service = processRunnerServicesByRoot.get(key);
  if (!service) {
    service = new ProcessRunnerService(key);
    processRunnerServicesByRoot.set(key, service);
  }
  return service;
}

function processScope(service: ProcessRunnerService): RuntimeLifecycleScope {
  let scope = service.getRuntimeScope();
  if (!scope || scope.isDisposed) {
    scope = createRuntimeLifecycleScope(`process-runtime:${service.projectRoot}`);
    service.setRuntimeScope(scope);
  }
  return scope;
}

function rememberProcessResource(service: ProcessRunnerService, procId: string, handle: RuntimeResourceHandle): RuntimeResourceHandle {
  let handles = service.processResourceHandles.get(procId);
  if (!handles) {
    handles = [];
    service.processResourceHandles.set(procId, handles);
  }
  handles.push(handle);
  return handle;
}

function unregisterProcessResource(service: ProcessRunnerService, procId: string, handle: RuntimeResourceHandle): void {
  handle.unregister();
  const handles = service.processResourceHandles.get(procId);
  if (!handles) return;
  const idx = handles.indexOf(handle);
  if (idx >= 0) handles.splice(idx, 1);
  if (handles.length === 0) service.processResourceHandles.delete(procId);
}

function unregisterAllProcessResources(service: ProcessRunnerService, procId: string): void {
  const handles = service.processResourceHandles.get(procId) ?? [];
  for (const handle of handles.splice(0)) handle.unregister();
  service.processResourceHandles.delete(procId);
}

function generateId(): string {
  return `proc-${randomBytes(6).toString('hex')}`;
}

function now(): string {
  return new Date().toISOString();
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

function commandHash(service: ProcessRunnerService, command: string): string {
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

function transientRegistry(service: ProcessRunnerService): Map<string, ProcessRecord> {
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

export function isProcessLiveAttached(procId: string): boolean {
  for (const service of processRunnerServicesByRoot.values()) {
    if (service.isProcessLiveAttached(procId)) return true;
  }
  return false;
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

async function waitForDurableOutput(service: ProcessRunnerService, procId: string): Promise<void> {
  const waiter = service.streamCloseWaiters.get(procId);
  if (!waiter) return;
  try {
    await waiter;
  } catch { void 0; 
  }
}

function loadRegistryForService(service: ProcessRunnerService): Map<string, ProcessRecord> {
  const registry = transientRegistry(service);
  const durable = durableRegistry(service.projectRoot);
  for (const [id, record] of durable) registry.set(id, record);
  return new Map(registry);
}

function saveRegistryForService(service: ProcessRunnerService, records: ProcessRecord[]): void {
  const registry = transientRegistry(service);
  registry.clear();
  for (const rec of records) {
    registry.set(rec.id, rec);
  }
  persistRegistry(service.projectRoot, registry);
}

function upsertRegistryRecord(service: ProcessRunnerService, record: ProcessRecord): void {
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
  combined: WriteStream;
} {
  const stdout = createWriteStream(join(dir, 'stdout.log'), { flags: 'a' });
  const stderr = createWriteStream(join(dir, 'stderr.log'), { flags: 'a' });
  const combined = createWriteStream(join(dir, 'combined.log'), { flags: 'a' });

  for (const stream of [stdout, stderr, combined]) {
    stream.on('error', () => {});
  }

  return { stdout, stderr, combined };
}

function closeAllStreams(service: ProcessRunnerService, procId: string): Promise<void> {
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

function finalizeProcess(service: ProcessRunnerService, procId: string): void {
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

function terminalNote(record: ProcessRecord): ProcessTerminalNote {
  return {
    route: 'planner',
    kind: 'process_terminal',
    process_id: record.id,
    card_id: record.card_id,
    goal_id: record.goal_id ?? null,
    status: record.status,
    exit_code: record.exit_code ?? null,
    signal: record.signal ?? null,
    classification: record.failure_classification ?? null,
  };
}

function deliveredSet(service: ProcessRunnerService): Set<string> {
  return service.deliveredTerminalNotes;
}

function bufferMap(service: ProcessRunnerService): Map<string, ProcessTerminalNote> {
  return service.bufferedTerminalNotes;
}

function dispatchTerminal(service: ProcessRunnerService, record: ProcessRecord): void {
  if (record.status === 'running') return;
  const delivered = deliveredSet(service);
  if (delivered.has(record.id)) return;
  const note = terminalNote(record);
  if (service.terminalPaused) {
    bufferMap(service).set(record.id, note);
    return;
  }
  delivered.add(record.id);
  for (const sink of service.terminalSinks) sink(note);
}

function registerProcessTerminalSinkForService(service: ProcessRunnerService, sink: ProcessTerminalSink): () => void {
  const sinks = service.terminalSinks;
  sinks.add(sink);
  const scope = processScope(service);
  const handle = scope.register({
    kind: 'listener',
    label: `terminal-sink:${service.projectRoot}`,
    dispose: () => {
      sinks?.delete(sink);
      return 'removed';
    },
  });
  return () => {
    handle.unregister();
    sinks?.delete(sink);
  };
}

function setProcessTerminalBufferingForService(service: ProcessRunnerService, paused: boolean): void {
  if (paused) {
    service.terminalPaused = true;
    return;
  }
  service.terminalPaused = false;
  const buffered = bufferMap(service);
  const delivered = deliveredSet(service);
  for (const [procId, note] of buffered) {
    if (delivered.has(procId)) continue;
    delivered.add(procId);
    for (const sink of service.terminalSinks) sink(note);
  }
  buffered.clear();
}

function startProcessForService(
  service: ProcessRunnerService,
  command: string,
  options: ProcessStartOptions,
): ProcessRecord {
  if (!command || command.length === 0) {
    throw new Error('command must not be empty');
  }

  const id = generateId();
  const projectRoot = service.projectRoot;
  const cwd = options.cwd ? resolve(options.cwd) : projectRoot;
  const dir = ensureProcessDir(projectRoot, id);

  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');
  const combinedLogPath = join(dir, 'combined.log');

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
    child.stdout.pipe(streams.combined, { end: false });
    child.stdout.on('end', () => onStreamEnd(service, id));
  }

  if (child.stderr) {
    child.stderr.pipe(streams.stderr);
    child.stderr.pipe(streams.combined, { end: false });
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
  rememberProcessResource(service, id, scope.registerStream(streams.combined, `combined:${id}`, `stream:combined:${id}`));

  const record: ProcessRecord = {
    id,
    card_id: options.cardId,
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
    combined_log_path: combinedLogPath,
    agent_session_id: options.agentSessionId ?? null,
    goal_id: options.goalId ?? null,
    launch_reason: options.launchReason ?? null,
    owner_kind: options.ownerKind ?? null,
    background_policy: options.backgroundPolicy ?? null,
    process_group_id: child.pid ?? null,
    reattach_state: 'attached',
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

    const latest = getProcessForService(service, id) ?? record;
    const updatedRecord: ProcessRecord = {
      ...latest,
      status: finalStatus,
      exit_code: exitCode,
      signal: signalCode ?? null,
      terminal_reason: signalCode ? 'signal' : 'exit',
      completed_at: now(),
      reattach_state: 'attached',
    };

    try {
      upsertRegistryRecord(service, updatedRecord);
      dispatchTerminal(service, updatedRecord);
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
      streams.combined.write(errorMsg);
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
      dispatchTerminal(service, updatedRecord);
    } catch { void 0; }
  });

  return record;
}

function onStreamEnd(service: ProcessRunnerService, procId: string): void {
  const current = service.pendingStreamCloses.get(procId);
  if (current === undefined) return;

  const remaining = current - 1;
  if (remaining <= 0) {
    finalizeProcess(service, procId);
  } else {
    service.pendingStreamCloses.set(procId, remaining);
  }
}

function waitProcessForService(
  service: ProcessRunnerService,
  procId: string,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  return new Promise((resolve) => {
    const waitStart = Date.now();
    const child = service.activeProcesses.get(procId);

    if (!child) {
      const registry = loadRegistryForService(service);
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
          const latest = getProcessForService(service, procId);
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

    const onExit = () => doResolve(false);
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

async function killProcessForService(service: ProcessRunnerService, procId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessRecord | null> {
  const record = getProcessForService(service, procId);
  if (!record) return null;
  if (record.status !== 'running') return record;
  const child = service.activeProcesses.get(procId);
  if (child && resolveStatus(child) === 'running') {
    signalProcessTree(child, signal);
    await waitProcessForService(service, procId, 5000);
    return getProcessForService(service, procId);
  }
  const updated: ProcessRecord = {
    ...record,
    status: 'killed',
    completed_at: now(),
    signal,
    terminal_reason: 'kill_unattached',
    reattach_state: 'lost',
    failure_classification: 'lost',
  };
  upsertRegistryRecord(service, updated);
  dispatchTerminal(service, updated);
  return updated;
}

async function startAndWaitForService(
  service: ProcessRunnerService,
  command: string,
  options: ProcessStartOptions,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  const record = startProcessForService(service, command, options);
  return waitProcessForService(service, record.id, timeoutMs);
}

function tailOutputForService(
  service: ProcessRunnerService,
  procId: string,
  lines: number = 50,
): string {
  const dir = processDir(service.projectRoot, procId);
  const combinedPath = join(dir, 'combined.log');

  if (!existsSync(combinedPath)) return '';

  const content = readFileSync(combinedPath, 'utf-8');
  if (!content) return '';

  const allLines = content.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  return allLines.slice(-lines).join('\n');
}

type ProcessReconciliationAuditKind = 'process_reconciled_dead' | 'process_reattach_rejected';
type ProcessReconciliationProbeStatus = 'not_running' | 'identity_mismatch' | 'clock_skew';

function auditProcessReconciliation(
  projectRoot: string,
  record: ProcessRecord,
  kind: ProcessReconciliationAuditKind,
  detail: string,
  probeStatus?: ProcessReconciliationProbeStatus,
): void {
  const safeDetail = redactOperatorErrorMessage(detail, projectRoot);
  const base = {
    kind,
    process_id: record.id,
    card_id: record.card_id,
    goal_id: record.goal_id ?? undefined,
    session_id: record.agent_session_id ?? undefined,
    pid: record.pid ?? null,
    terminal_reason: 'lost' as const,
    failure_classification: 'lost' as const,
    detail: safeDetail,
  };
  const event = kind === 'process_reconciled_dead'
    ? { ...base, probe_status: probeStatus ?? 'identity_mismatch' }
    : { ...base, reattach_error: safeDetail };
  const logger = new EventLogger(join(projectRoot, '.saivage'));
  try {
    logger.appendEvent(event);
    logger.flushSync();
  } finally {
    logger.close();
  }
  if (record.agent_session_id) {
    const action = kind === 'process_reconciled_dead' ? 'reconciled as dead during restart' : 'reattach was rejected during restart';
    queueNotification(projectRoot, { kind: 'session', sessionId: record.agent_session_id }, 'process_state', `Process ${record.id} for card ${record.card_id} ${action}: ${safeDetail}`, { actor: 'runtime', surface: 'runtime' });
  }
}

function markLost(service: ProcessRunnerService, record: ProcessRecord, reason: string, audit?: { kind: ProcessReconciliationAuditKind; probeStatus?: ProcessReconciliationProbeStatus }): ProcessRecord {
  const projectRoot = service.projectRoot;
  const updated: ProcessRecord = {
    ...record,
    status: 'failed',
    completed_at: record.completed_at ?? now(),
    exit_code: record.exit_code ?? null,
    signal: record.signal ?? null,
    terminal_reason: 'lost',
    reattach_state: 'lost',
    failure_classification: 'lost',
    reattach_error: reason,
  };
  upsertRegistryRecord(service, updated);
  dispatchTerminal(service, updated);
  if (audit) auditProcessReconciliation(projectRoot, updated, audit.kind, reason, audit.probeStatus);
  return updated;
}

function defaultProbe(record: ProcessRecord): { running: boolean; pid?: number | null; started_at_monotonic?: number | null } {
  if (!record.pid) return { running: false };
  try {
    process.kill(record.pid, 0);
    return { running: true, pid: record.pid, started_at_monotonic: record.started_at_monotonic };
  } catch {
    return { running: false, pid: record.pid };
  }
}

function reconcileProcessRecordsForService(service: ProcessRunnerService, options: ProcessReconcileOptions = {}): ProcessReconcileResult {
  const projectRoot = service.projectRoot;
  const result: ProcessReconcileResult = { matched: [], lost: [], skewed: [] };
  const records = Array.from(loadRegistryForService(service).values()).filter((record) => record.status === 'running');
  const currentMonotonic = options.nowMonotonicMs ?? nowMonotonic();
  const maxClockSkewMs = options.maxClockSkewMs ?? 60_000;
  const probe = options.probe ?? defaultProbe;
  const reattach = options.reattach ?? (() => true);

  for (const record of records) {
    if (record.started_at_monotonic > currentMonotonic + maxClockSkewMs) {
      result.skewed.push(record.id);
      markLost(service, record, 'started_at_monotonic is in the future beyond clock-skew tolerance', { kind: 'process_reconciled_dead', probeStatus: 'clock_skew' });
      result.lost.push(record.id);
      continue;
    }
    const identity = probe(record);
    const monotonicMatches = identity.started_at_monotonic === undefined || identity.started_at_monotonic === null || Math.abs(identity.started_at_monotonic - record.started_at_monotonic) <= maxClockSkewMs;
    if (!identity.running || identity.pid !== record.pid || !monotonicMatches) {
      markLost(service, record, 'restart identity probe mismatch', { kind: 'process_reconciled_dead', probeStatus: identity.running ? 'identity_mismatch' : 'not_running' });
      result.lost.push(record.id);
      continue;
    }
    if (!reattach(record)) {
      markLost(service, record, 'process reattach failed', { kind: 'process_reattach_rejected' });
      result.lost.push(record.id);
      continue;
    }
    const updated = { ...record, reattach_state: 'reattached' as const };
    upsertRegistryRecord(service, updated);
    result.matched.push(record.id);
  }
  return result;
}

async function stopProcessForRuntimeShutdown(
  service: ProcessRunnerService,
  procId: string,
  graceMs: number = 5000,
): Promise<ProcessRecord | null> {
  const child = service.activeProcesses.get(procId);
  if (!child || resolveStatus(child) !== 'running') {
    return getProcessForService(service, procId);
  }

  signalProcessTree(child, 'SIGTERM');
  const waitResult = await waitProcessForService(service, procId, graceMs);
  if (waitResult.timedOut || waitResult.status === 'running') {
    signalProcessTree(child, 'SIGKILL');
    await waitProcessForService(service, procId, 2000);
  }
  return getProcessForService(service, procId);
}

function listProcessesForService(
  service: ProcessRunnerService,
  filter?: ProcessListFilter,
): ProcessRecord[] {
  const registry = loadRegistryForService(service);
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

function getProcessForService(
  service: ProcessRunnerService,
  procId: string,
): ProcessRecord | null {
  const registry = loadRegistryForService(service);
  return registry.get(procId) ?? null;
}

function cleanupProcessOutputForService(service: ProcessRunnerService, procId: string): boolean {
  const projectRoot = service.projectRoot;
  const registry = loadRegistryForService(service);
  const record = registry.get(procId);

  if (!record) return false;
  if (record.status === 'running') return false;

  const dir = processDir(projectRoot, procId);
  if (!existsSync(dir)) return true;

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }

  return true;
}

function cleanupAllCompletedForService(service: ProcessRunnerService): number {
  const registry = loadRegistryForService(service);
  let count = 0;

  for (const [procId, record] of registry) {
    if (record.status !== 'running') {
      if (cleanupProcessOutputForService(service, procId)) {
        count++;
      }
    }
  }

  return count;
}

async function stopAllRunningForRuntimeShutdownForService(service: ProcessRunnerService): Promise<string[]> {
  const stoppedIds: string[] = [];

  for (const [procId, child] of service.activeProcesses) {
    try {
      await stopProcessForRuntimeShutdown(service, procId);
      stoppedIds.push(procId);
    } catch {
      try {
        child.kill('SIGKILL');
        stoppedIds.push(procId);
      } catch { void 0; }
    }
  }

  return stoppedIds;
}

async function disposeProcessRuntimeScopeForService(service: ProcessRunnerService): Promise<RuntimeDisposeReportEntry[]> {
  const preStopResources = processScope(service).snapshot().resources;
  const stoppedIds = await stopAllRunningForRuntimeShutdownForService(service);
  const scope = processScope(service);
  const report = await scope.dispose();
  for (const procId of stoppedIds) {
    if (!report.some((entry) => entry.id === `child:${procId}`)) {
      report.push({ id: `child:${procId}`, kind: 'child_process', label: `child:${procId}`, status: 'killed' });
    }
  }
  for (const resource of preStopResources) {
    if (resource.kind === 'stream' && !report.some((entry) => entry.id === resource.id)) {
      report.push({ id: resource.id, kind: 'stream', label: resource.label, status: 'closed' });
    }
  }
  service.setRuntimeScope(null);
  service.terminalSinks.clear();
  service.terminalPaused = false;
  service.bufferedTerminalNotes.clear();
  service.deliveredTerminalNotes.clear();
  for (const procId of stoppedIds) {
    service.processResourceHandles.delete(procId);
  }
  return report;
}

export function loadRegistry(projectRoot: string): Map<string, ProcessRecord> {
  return serviceFor(projectRoot).loadRegistry();
}

export function saveRegistry(projectRoot: string, records: ProcessRecord[]): void {
  serviceFor(projectRoot).saveRegistry(records);
}

export function registerProcessTerminalSink(projectRoot: string, sink: ProcessTerminalSink): () => void {
  return serviceFor(projectRoot).registerProcessTerminalSink(sink);
}

export function setProcessTerminalBuffering(projectRoot: string, paused: boolean): void {
  serviceFor(projectRoot).setProcessTerminalBuffering(paused);
}

export function startProcess(projectRoot: string, command: string, options: ProcessStartOptions): ProcessRecord {
  return serviceFor(projectRoot).startProcess(command, options);
}

export function waitProcess(projectRoot: string, procId: string, timeoutMs: number = 0): Promise<ProcessWaitResult> {
  return serviceFor(projectRoot).waitProcess(procId, timeoutMs);
}

export function killProcess(projectRoot: string, procId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessRecord | null> {
  return serviceFor(projectRoot).killProcess(procId, signal);
}

export function startAndWait(projectRoot: string, command: string, options: ProcessStartOptions, timeoutMs: number = 0): Promise<ProcessWaitResult> {
  return serviceFor(projectRoot).startAndWait(command, options, timeoutMs);
}

export function tailOutput(projectRoot: string, procId: string, lines: number = 50): string {
  return serviceFor(projectRoot).tailOutput(procId, lines);
}

export function reconcileProcessRecords(projectRoot: string, options: ProcessReconcileOptions = {}): ProcessReconcileResult {
  return serviceFor(projectRoot).reconcileProcessRecords(options);
}

export function listProcesses(projectRoot: string, filter?: ProcessListFilter): ProcessRecord[] {
  return serviceFor(projectRoot).listProcesses(filter);
}

export function getProcess(projectRoot: string, procId: string): ProcessRecord | null {
  return serviceFor(projectRoot).getProcess(procId);
}

export function cleanupProcessOutput(projectRoot: string, procId: string): boolean {
  return serviceFor(projectRoot).cleanupProcessOutput(procId);
}

export function cleanupAllCompleted(projectRoot: string): number {
  return serviceFor(projectRoot).cleanupAllCompleted();
}

export function stopAllRunningForRuntimeShutdown(projectRoot: string): Promise<string[]> {
  return serviceFor(projectRoot).stopAllRunningForRuntimeShutdown();
}

export function snapshotProcessRuntimeScope(projectRoot: string): RuntimeLifecycleSnapshot {
  return serviceFor(projectRoot).snapshotProcessRuntimeScope();
}

export async function disposeProcessRuntimeScope(projectRoot: string): Promise<RuntimeDisposeReportEntry[]> {
  const service = serviceFor(projectRoot);
  const report = await service.disposeProcessRuntimeScope();
  processRunnerServicesByRoot.delete(service.projectRoot);
  return report;
}
