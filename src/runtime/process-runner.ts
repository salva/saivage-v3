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
import { writeFileAtomic, explainLegacyStateRejection } from '../utils/file-tree.js';
import { redactCommandForOperator, redactOperatorErrorMessage } from '../utils/file-access-security.js';
import { EventLogger } from '../utils/event-logger.js';
import { enqueueProcessReconciliationNotification } from '../utils/notification-triggers.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/types.js';

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
const processRecordsByRoot = new Map<string, Map<string, ProcessRecord>>();
const commandHashSalts = new Map<string, Buffer>();

const activeProcesses = new Map<string, ChildProcess>();
const outputStreams = new Map<
  string,
  { stdout: WriteStream; stderr: WriteStream; combined: WriteStream }
>();
const pendingStreamCloses = new Map<string, number>();
const streamCloseWaiters = new Map<string, Promise<void>>();
const terminalSinksByRoot = new Map<string, Set<ProcessTerminalSink>>();
const pausedRoots = new Set<string>();
const bufferedTerminalNotesByRoot = new Map<string, Map<string, ProcessTerminalNote>>();
const deliveredTerminalNotesByRoot = new Map<string, Set<string>>();
const processScopesByRoot = new Map<string, RuntimeLifecycleScope>();
const processRootById = new Map<string, string>();
const processResourceHandles = new Map<string, RuntimeResourceHandle[]>();

function processScope(projectRoot: string): RuntimeLifecycleScope {
  let scope = processScopesByRoot.get(projectRoot);
  if (!scope || scope.isDisposed) {
    scope = createRuntimeLifecycleScope(`process-runtime:${projectRoot}`);
    processScopesByRoot.set(projectRoot, scope);
  }
  return scope;
}

function rememberProcessResource(projectRoot: string, procId: string, handle: RuntimeResourceHandle): RuntimeResourceHandle {
  processRootById.set(procId, projectRoot);
  let handles = processResourceHandles.get(procId);
  if (!handles) {
    handles = [];
    processResourceHandles.set(procId, handles);
  }
  handles.push(handle);
  return handle;
}

function unregisterProcessResource(procId: string, handle: RuntimeResourceHandle): void {
  handle.unregister();
  const handles = processResourceHandles.get(procId);
  if (!handles) return;
  const idx = handles.indexOf(handle);
  if (idx >= 0) handles.splice(idx, 1);
  if (handles.length === 0) processResourceHandles.delete(procId);
}

function unregisterAllProcessResources(procId: string): void {
  const handles = processResourceHandles.get(procId) ?? [];
  for (const handle of handles.splice(0)) handle.unregister();
  processResourceHandles.delete(procId);
  processRootById.delete(procId);
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

function saltForRoot(projectRoot: string): Buffer {
  let salt = commandHashSalts.get(projectRoot);
  if (!salt) {
    salt = randomBytes(32);
    commandHashSalts.set(projectRoot, salt);
  }
  return salt;
}

function commandHash(projectRoot: string, command: string): string {
  return createHash('sha256').update(saltForRoot(projectRoot)).update('\0').update(command).digest('hex');
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

function transientRegistry(projectRoot: string): Map<string, ProcessRecord> {
  let registry = processRecordsByRoot.get(projectRoot);
  if (!registry) {
    registry = durableRegistry(projectRoot);
    processRecordsByRoot.set(projectRoot, registry);
  }
  return registry;
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
  const child = activeProcesses.get(procId);
  return Boolean(child && resolveStatus(child) === 'running');
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

async function waitForDurableOutput(procId: string): Promise<void> {
  const waiter = streamCloseWaiters.get(procId);
  if (!waiter) return;
  try {
    await waiter;
  } catch {
  }
}

export function loadRegistry(projectRoot: string): Map<string, ProcessRecord> {
  const registry = transientRegistry(projectRoot);
  const durable = durableRegistry(projectRoot);
  for (const [id, record] of durable) registry.set(id, record);
  return new Map(registry);
}

export function saveRegistry(projectRoot: string, records: ProcessRecord[]): void {
  const registry = transientRegistry(projectRoot);
  registry.clear();
  for (const rec of records) {
    registry.set(rec.id, rec);
  }
  persistRegistry(projectRoot, registry);
}

function upsertRegistryRecord(projectRoot: string, record: ProcessRecord): void {
  const registry = transientRegistry(projectRoot);
  registry.set(record.id, record);
  persistRegistry(projectRoot, registry);
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

function closeAllStreams(procId: string): Promise<void> {
  const streams = outputStreams.get(procId);
  if (!streams) return Promise.resolve();

  outputStreams.delete(procId);

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

function finalizeProcess(procId: string): void {
  const child = activeProcesses.get(procId);
  if (child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }
  unregisterAllProcessResources(procId);
  const closePromise = closeAllStreams(procId).finally(() => {
    streamCloseWaiters.delete(procId);
  });
  streamCloseWaiters.set(procId, closePromise);
  activeProcesses.delete(procId);
  pendingStreamCloses.delete(procId);
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

function deliveredSet(projectRoot: string): Set<string> {
  let delivered = deliveredTerminalNotesByRoot.get(projectRoot);
  if (!delivered) {
    delivered = new Set();
    deliveredTerminalNotesByRoot.set(projectRoot, delivered);
  }
  return delivered;
}

function bufferMap(projectRoot: string): Map<string, ProcessTerminalNote> {
  let buffered = bufferedTerminalNotesByRoot.get(projectRoot);
  if (!buffered) {
    buffered = new Map();
    bufferedTerminalNotesByRoot.set(projectRoot, buffered);
  }
  return buffered;
}

function dispatchTerminal(projectRoot: string, record: ProcessRecord): void {
  if (record.status === 'running') return;
  const delivered = deliveredSet(projectRoot);
  if (delivered.has(record.id)) return;
  const note = terminalNote(record);
  if (pausedRoots.has(projectRoot)) {
    bufferMap(projectRoot).set(record.id, note);
    return;
  }
  delivered.add(record.id);
  for (const sink of terminalSinksByRoot.get(projectRoot) ?? []) sink(note);
}

export function registerProcessTerminalSink(projectRoot: string, sink: ProcessTerminalSink): () => void {
  let sinks = terminalSinksByRoot.get(projectRoot);
  if (!sinks) {
    sinks = new Set();
    terminalSinksByRoot.set(projectRoot, sinks);
  }
  sinks.add(sink);
  const scope = processScope(projectRoot);
  const handle = scope.register({
    kind: 'listener',
    label: `terminal-sink:${projectRoot}`,
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

export function setProcessTerminalBuffering(projectRoot: string, paused: boolean): void {
  if (paused) {
    pausedRoots.add(projectRoot);
    return;
  }
  pausedRoots.delete(projectRoot);
  const buffered = bufferMap(projectRoot);
  const delivered = deliveredSet(projectRoot);
  for (const [procId, note] of buffered) {
    if (delivered.has(procId)) continue;
    delivered.add(procId);
    for (const sink of terminalSinksByRoot.get(projectRoot) ?? []) sink(note);
  }
  buffered.clear();
}

export function startProcess(
  projectRoot: string,
  command: string,
  options: ProcessStartOptions,
): ProcessRecord {
  if (!command || command.length === 0) {
    throw new Error('command must not be empty');
  }

  const id = generateId();
  const cwd = options.cwd ? resolve(options.cwd) : projectRoot;
  const dir = ensureProcessDir(projectRoot, id);

  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');
  const combinedLogPath = join(dir, 'combined.log');

  const streams = openOutputStreams(dir);
  pendingStreamCloses.set(id, 2);

  const childEnv = {
    ...process.env,
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
    child.stdout.on('end', () => onStreamEnd(id));
  }

  if (child.stderr) {
    child.stderr.pipe(streams.stderr);
    child.stderr.pipe(streams.combined, { end: false });
    child.stderr.on('end', () => onStreamEnd(id));
  }

  if (!child.stdout && !child.stderr) {
    pendingStreamCloses.set(id, 0);
  }

  activeProcesses.set(id, child);
  outputStreams.set(id, streams);
  const scope = processScope(projectRoot);
  rememberProcessResource(projectRoot, id, scope.registerChildProcess(child, 'detach', `child:${id}`, `child:${id}`));
  rememberProcessResource(projectRoot, id, scope.registerStream(streams.stdout, `stdout:${id}`, `stream:stdout:${id}`));
  rememberProcessResource(projectRoot, id, scope.registerStream(streams.stderr, `stderr:${id}`, `stream:stderr:${id}`));
  rememberProcessResource(projectRoot, id, scope.registerStream(streams.combined, `combined:${id}`, `stream:combined:${id}`));

  const record: ProcessRecord = {
    id,
    card_id: options.cardId,
    command: redactCommandForOperator(command),
    command_hash: commandHash(projectRoot, command),
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

  upsertRegistryRecord(projectRoot, record);

  child.on('exit', (exitCode, signalCode) => {
    const finalStatus: ProcessStatus =
      signalCode === 'SIGKILL' || signalCode === 'SIGTERM'
        ? 'killed'
        : exitCode === 0
          ? 'exited'
          : 'failed';

    const latest = getProcess(projectRoot, id) ?? record;
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
      upsertRegistryRecord(projectRoot, updatedRecord);
      dispatchTerminal(projectRoot, updatedRecord);
    } catch {}

    const pending = pendingStreamCloses.get(id);
    if (pending !== undefined && pending <= 0) {
      finalizeProcess(id);
    }

    const cleanupTimer = setTimeout(() => {
      if (activeProcesses.has(id) || outputStreams.has(id)) {
        finalizeProcess(id);
      }
      unregisterProcessResource(id, cleanupTimerHandle);
    }, 5000);
    cleanupTimer.unref();
    const cleanupTimerHandle = rememberProcessResource(projectRoot, id, processScope(projectRoot).registerTimer(cleanupTimer, `cleanup-timer:${id}`, `timer:cleanup:${id}`));
  });

  child.on('error', (err) => {
    const errorMsg = `[process-runner] spawn error: ${err.message}\n`;
    try {
      streams.stderr.write(errorMsg);
      streams.combined.write(errorMsg);
    } catch {}

    const updatedRecord: ProcessRecord = {
      ...record,
      status: 'failed',
      exit_code: -1,
      signal: null,
      terminal_reason: 'spawn_error',
      failure_classification: 'spawn_error',
      completed_at: now(),
    };

    finalizeProcess(id);

    try {
      upsertRegistryRecord(projectRoot, updatedRecord);
      dispatchTerminal(projectRoot, updatedRecord);
    } catch {}
  });

  return record;
}

function onStreamEnd(procId: string): void {
  const current = pendingStreamCloses.get(procId);
  if (current === undefined) return;

  const remaining = current - 1;
  if (remaining <= 0) {
    finalizeProcess(procId);
  } else {
    pendingStreamCloses.set(procId, remaining);
  }
}

export function waitProcess(
  projectRoot: string,
  procId: string,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  return new Promise((resolve) => {
    const waitStart = Date.now();
    const child = activeProcesses.get(procId);

    if (!child) {
      const registry = loadRegistry(projectRoot);
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

      void waitForDurableOutput(procId).finally(() => {
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
      void waitForDurableOutput(procId).finally(() => {
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

      if (timerHandle) { unregisterProcessResource(procId, timerHandle); timerHandle = null; }
      if (exitHandle) { unregisterProcessResource(procId, exitHandle); exitHandle = null; }
      if (closeHandle) { unregisterProcessResource(procId, closeHandle); closeHandle = null; }
      if (errorHandle) { unregisterProcessResource(procId, errorHandle); errorHandle = null; }
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
        void waitForDurableOutput(procId).finally(() => {
          const latest = getProcess(projectRoot, procId);
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
    const scope = processScope(projectRoot);
    exitHandle = rememberProcessResource(projectRoot, procId, scope.registerListener(child, 'exit', onExit as (...args: unknown[]) => void, `wait-exit:${procId}`));
    closeHandle = rememberProcessResource(projectRoot, procId, scope.registerListener(child, 'close', onClose as (...args: unknown[]) => void, `wait-close:${procId}`));
    errorHandle = rememberProcessResource(projectRoot, procId, scope.registerListener(child, 'error', onError as (...args: unknown[]) => void, `wait-error:${procId}`));

    if (timeoutMs > 0) {
      timer = setTimeout(() => doResolve(true), timeoutMs);
      timerHandle = rememberProcessResource(projectRoot, procId, scope.registerTimer(timer, `wait-timeout:${procId}`));
    }
  });
}

export async function killProcess(projectRoot: string, procId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessRecord | null> {
  const record = getProcess(projectRoot, procId);
  if (!record) return null;
  if (record.status !== 'running') return record;
  const child = activeProcesses.get(procId);
  if (child && resolveStatus(child) === 'running') {
    signalProcessTree(child, signal);
    await waitProcess(projectRoot, procId, 5000);
    return getProcess(projectRoot, procId);
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
  upsertRegistryRecord(projectRoot, updated);
  dispatchTerminal(projectRoot, updated);
  return updated;
}

export async function startAndWait(
  projectRoot: string,
  command: string,
  options: ProcessStartOptions,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  const record = startProcess(projectRoot, command, options);
  return waitProcess(projectRoot, record.id, timeoutMs);
}

export function tailOutput(
  projectRoot: string,
  procId: string,
  lines: number = 50,
): string {
  const dir = processDir(projectRoot, procId);
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
  enqueueProcessReconciliationNotification(projectRoot, record, kind, safeDetail, { actor: 'runtime', surface: 'runtime' });
}

function markLost(projectRoot: string, record: ProcessRecord, reason: string, audit?: { kind: ProcessReconciliationAuditKind; probeStatus?: ProcessReconciliationProbeStatus }): ProcessRecord {
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
  upsertRegistryRecord(projectRoot, updated);
  dispatchTerminal(projectRoot, updated);
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

export function reconcileProcessRecords(projectRoot: string, options: ProcessReconcileOptions = {}): ProcessReconcileResult {
  const result: ProcessReconcileResult = { matched: [], lost: [], skewed: [] };
  const records = Array.from(loadRegistry(projectRoot).values()).filter((record) => record.status === 'running');
  const currentMonotonic = options.nowMonotonicMs ?? nowMonotonic();
  const maxClockSkewMs = options.maxClockSkewMs ?? 60_000;
  const probe = options.probe ?? defaultProbe;
  const reattach = options.reattach ?? (() => true);

  for (const record of records) {
    if (record.started_at_monotonic > currentMonotonic + maxClockSkewMs) {
      result.skewed.push(record.id);
      markLost(projectRoot, record, 'started_at_monotonic is in the future beyond clock-skew tolerance', { kind: 'process_reconciled_dead', probeStatus: 'clock_skew' });
      result.lost.push(record.id);
      continue;
    }
    const identity = probe(record);
    const monotonicMatches = identity.started_at_monotonic === undefined || identity.started_at_monotonic === null || Math.abs(identity.started_at_monotonic - record.started_at_monotonic) <= maxClockSkewMs;
    if (!identity.running || identity.pid !== record.pid || !monotonicMatches) {
      markLost(projectRoot, record, 'restart identity probe mismatch', { kind: 'process_reconciled_dead', probeStatus: identity.running ? 'identity_mismatch' : 'not_running' });
      result.lost.push(record.id);
      continue;
    }
    if (!reattach(record)) {
      markLost(projectRoot, record, 'process reattach failed', { kind: 'process_reattach_rejected' });
      result.lost.push(record.id);
      continue;
    }
    const updated = { ...record, reattach_state: 'reattached' as const };
    upsertRegistryRecord(projectRoot, updated);
    result.matched.push(record.id);
  }
  return result;
}

async function stopProcessForRuntimeShutdown(
  projectRoot: string,
  procId: string,
  graceMs: number = 5000,
): Promise<ProcessRecord | null> {
  const child = activeProcesses.get(procId);
  if (!child || resolveStatus(child) !== 'running') {
    return getProcess(projectRoot, procId);
  }

  signalProcessTree(child, 'SIGTERM');
  const waitResult = await waitProcess(projectRoot, procId, graceMs);
  if (waitResult.timedOut || waitResult.status === 'running') {
    signalProcessTree(child, 'SIGKILL');
    await waitProcess(projectRoot, procId, 2000);
  }
  return getProcess(projectRoot, procId);
}

export function listProcesses(
  projectRoot: string,
  filter?: ProcessListFilter,
): ProcessRecord[] {
  const registry = loadRegistry(projectRoot);
  const records = Array.from(registry.values());

  for (const [procId, child] of activeProcesses) {
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

export function getProcess(
  projectRoot: string,
  procId: string,
): ProcessRecord | null {
  const registry = loadRegistry(projectRoot);
  return registry.get(procId) ?? null;
}

export function cleanupProcessOutput(projectRoot: string, procId: string): boolean {
  const registry = loadRegistry(projectRoot);
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

export function cleanupAllCompleted(projectRoot: string): number {
  const registry = loadRegistry(projectRoot);
  let count = 0;

  for (const [procId, record] of registry) {
    if (record.status !== 'running') {
      if (cleanupProcessOutput(projectRoot, procId)) {
        count++;
      }
    }
  }

  return count;
}

export async function stopAllRunningForRuntimeShutdown(projectRoot: string): Promise<string[]> {
  const stoppedIds: string[] = [];

  for (const [procId, child] of activeProcesses) {
    if (processRootById.get(procId) !== projectRoot) continue;
    try {
      await stopProcessForRuntimeShutdown(projectRoot, procId);
      stoppedIds.push(procId);
    } catch {
      try {
        child.kill('SIGKILL');
        stoppedIds.push(procId);
      } catch {}
    }
  }

  return stoppedIds;
}

export function snapshotProcessRuntimeScope(projectRoot: string): RuntimeLifecycleSnapshot {
  return processScope(projectRoot).snapshot();
}

export async function disposeProcessRuntimeScope(projectRoot: string): Promise<RuntimeDisposeReportEntry[]> {
  const preStopResources = processScope(projectRoot).snapshot().resources;
  const stoppedIds = await stopAllRunningForRuntimeShutdown(projectRoot);
  const scope = processScope(projectRoot);
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
  processScopesByRoot.delete(projectRoot);
  terminalSinksByRoot.delete(projectRoot);
  pausedRoots.delete(projectRoot);
  bufferedTerminalNotesByRoot.delete(projectRoot);
  deliveredTerminalNotesByRoot.delete(projectRoot);
  for (const procId of stoppedIds) {
    processRootById.delete(procId);
    processResourceHandles.delete(procId);
  }
  return report;
}
