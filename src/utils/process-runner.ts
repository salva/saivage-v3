import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
  type WriteStream,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { processRecordSchema } from '../schemas/validators.js';
import type { ProcessRecord, ProcessStatus } from '../schemas/types.js';
import { writeFileAtomic } from './file-tree.js';

// ── Types ─────────────────────────────────────────────────────

export interface ProcessStartOptions {
  /** Card ID this process is associated with */
  cardId: string;
  /** Working directory for the child process */
  cwd?: string;
  /** Environment variables to merge into the child's environment */
  env?: Record<string, string>;
  /** Whether this process is required for card completion */
  requiredForCardCompletion?: boolean;
  /** Agent session ID launching this process */
  agentSessionId?: string;
  /** Goal ID associated with this process */
  goalId?: string;
  /** Human-readable reason for launching */
  launchReason?: string;
  /** Who owns this process */
  ownerKind?: 'agent' | 'operator' | 'runtime';
  /** Background execution policy */
  backgroundPolicy?: 'foreground' | 'background_required' | 'background_optional' | 'detach' | 'kill_on_freeze';
}

export interface ProcessWaitResult {
  /** Process ID */
  id: string;
  /** Final status after waiting */
  status: ProcessStatus;
  /** Exit code (if exited normally) */
  exitCode: number | null;
  /** Whether the wait timed out */
  timedOut: boolean;
  /** Duration from wait call to resolution, in milliseconds */
  waitDurationMs: number;
}

export interface ProcessListFilter {
  /** Filter by card_id */
  cardId?: string;
  /** Filter by status */
  status?: ProcessStatus | ProcessStatus[];
}

// ── Constants ─────────────────────────────────────────────────

const PROCESSES_DIR = '.saivage-work/processes';
const REGISTRY_FILE = '.saivage/runtime/processes.json';

// ── In-Memory State ───────────────────────────────────────────

/**
 * Active child process handles kept in memory.
 * Key: process ID, Value: ChildProcess handle.
 */
const activeProcesses = new Map<string, ChildProcess>();

/**
 * Active write streams for process output files.
 * Key: process ID, Value: { stdout, stderr, combined }.
 */
const outputStreams = new Map<
  string,
  { stdout: WriteStream; stderr: WriteStream; combined: WriteStream }
>();

/**
 * Track pending stream closes for each process.
 */
const pendingStreamCloses = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────

function generateId(): string {
  return `proc-${randomBytes(6).toString('hex')}`;
}

function now(): string {
  return new Date().toISOString();
}

function processesDir(projectRoot: string): string {
  return join(projectRoot, PROCESSES_DIR);
}

function processDir(projectRoot: string, procId: string): string {
  return join(processesDir(projectRoot), procId);
}

function registryPath(projectRoot: string): string {
  return join(projectRoot, REGISTRY_FILE);
}

/**
 * Resolve the status of a child process from its current state.
 *
 * IMPORTANT: Do NOT check proc.killed — it is set to true as soon
 * as kill() is called, before the process actually exits. Only use
 * signalCode and exitCode which are set after the 'exit' event fires.
 */
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
  if (proc.signalCode !== null) return null; // killed by signal, no exit code
  return null;
}

// ── Registry Persistence ──────────────────────────────────────

/**
 * Load the process registry from disk.
 */
export function loadRegistry(projectRoot: string): Map<string, ProcessRecord> {
  const rp = registryPath(projectRoot);
  if (!existsSync(rp)) {
    return new Map();
  }

  const raw = readFileSync(rp, 'utf-8');
  let records: ProcessRecord[];
  try {
    records = JSON.parse(raw) as ProcessRecord[];
  } catch {
    return new Map();
  }

  const map = new Map<string, ProcessRecord>();
  for (const rec of records) {
    const parsed = processRecordSchema.safeParse(rec);
    if (parsed.success) {
      map.set(parsed.data.id, parsed.data);
    }
  }
  return map;
}

/**
 * Save the process registry to disk atomically.
 * Validates each record with Zod before writing.
 */
export function saveRegistry(projectRoot: string, records: ProcessRecord[]): void {
  for (const rec of records) {
    const parsed = processRecordSchema.safeParse(rec);
    if (!parsed.success) {
      throw new Error(
        `ProcessRecord validation failed for ${rec.id}: ${parsed.error.message}`,
      );
    }
  }
  writeFileAtomic(registryPath(projectRoot), JSON.stringify(records, null, 2) + '\n');
}

function upsertRegistryRecord(projectRoot: string, record: ProcessRecord): void {
  const existing = loadRegistry(projectRoot);
  existing.set(record.id, record);
  const records = Array.from(existing.values());
  saveRegistry(projectRoot, records);
}

// ── Output Stream Management ──────────────────────────────────

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

  // Suppress unhandled 'error' events: if the temp dir is cleaned up
  // before the streams are fully closed (e.g., during test teardown),
  // the resulting ENOENT on write/close would otherwise crash the process.
  for (const stream of [stdout, stderr, combined]) {
    stream.on('error', () => {});
  }

  return { stdout, stderr, combined };
}

/**
 * Close all output streams and return a Promise that resolves when
 * all streams have been fully flushed and closed (their 'close' event fires).
 *
 * This prevents the race condition where tests read output files before
 * the write buffer has been flushed to disk.
 */
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
  // Fire-and-forget: close streams asynchronously
  closeAllStreams(procId).catch(() => {});
  activeProcesses.delete(procId);
  pendingStreamCloses.delete(procId);
}

// ── Public API: startProcess ──────────────────────────────────

/**
 * Spawn a child process, writing stdout/stderr/combined to files under
 * .saivage-work/processes/<proc-id>/.
 *
 * Throws an Error if the command string is empty, since an empty command
 * produces an invalid ProcessRecord (Zod requires command length >= 1).
 */
export function startProcess(
  projectRoot: string,
  command: string,
  options: ProcessStartOptions,
): ProcessRecord {
  // Validate command upfront — empty string produces invalid ProcessRecord
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
  // Track pending stream ends: stdout + stderr = 2
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
    detached: false,
  });

  // Pipe stdout
  if (child.stdout) {
    child.stdout.pipe(streams.stdout);
    child.stdout.pipe(streams.combined, { end: false });
    child.stdout.on('end', () => onStreamEnd(id));
  }

  // Pipe stderr
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

  const record: ProcessRecord = {
    id,
    card_id: options.cardId,
    command,
    cwd,
    status: 'running',
    pid: child.pid ?? null,
    started_at: now(),
    completed_at: null,
    exit_code: null,
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
    process_group_id: null,
  };

  // Persist immediately
  upsertRegistryRecord(projectRoot, record);

  // Handle process exit
  child.on('exit', (exitCode, signalCode) => {
    const finalStatus: ProcessStatus =
      signalCode === 'SIGKILL' || signalCode === 'SIGTERM'
        ? 'killed'
        : exitCode === 0
          ? 'exited'
          : 'failed';

    const updatedRecord: ProcessRecord = {
      ...record,
      status: finalStatus,
      exit_code: exitCode,
      completed_at: now(),
    };

    // Update registry synchronously
    try {
      upsertRegistryRecord(projectRoot, updatedRecord);
    } catch { /* best effort */ }

    // If no streams to wait for, clean up
    const pending = pendingStreamCloses.get(id);
    if (pending !== undefined && pending <= 0) {
      finalizeProcess(id);
    }

    // Safety timeout: force cleanup after 5 seconds
    setTimeout(() => {
      if (activeProcesses.has(id) || outputStreams.has(id)) {
        finalizeProcess(id);
      }
    }, 5000);
  });

  // Handle spawn errors
  child.on('error', (err) => {
    const errorMsg = `[process-runner] spawn error: ${err.message}\n`;
    try {
      streams.stderr.write(errorMsg);
      streams.combined.write(errorMsg);
    } catch { /* ignore */ }

    const updatedRecord: ProcessRecord = {
      ...record,
      status: 'failed',
      exit_code: -1,
      completed_at: now(),
    };

    finalizeProcess(id);

    try {
      upsertRegistryRecord(projectRoot, updatedRecord);
    } catch { /* best effort */ }
  });

  return record;
}

/** Called when a single stdout or stderr stream ends. */
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

// ── Public API: waitProcess ───────────────────────────────────

/**
 * Wait for a process to exit, with an optional timeout.
 *
 * CRITICAL: A timed-out wait does NOT kill the process.
 */
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

      resolve({
        id: procId,
        status: record.status,
        exitCode: record.exit_code ?? null,
        timedOut: false,
        waitDurationMs: Date.now() - waitStart,
      });
      return;
    }

    const currentStatus = resolveStatus(child);
    if (currentStatus !== 'running') {
      resolve({
        id: procId,
        status: currentStatus,
        exitCode: resolveExitCode(child),
        timedOut: false,
        waitDurationMs: Date.now() - waitStart,
      });
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    let resolved = false;

    const doResolve = (timedOut: boolean) => {
      if (resolved) return;
      resolved = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

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
        resolve({
          id: procId,
          status: resolveStatus(child),
          exitCode: resolveExitCode(child),
          timedOut: false,
          waitDurationMs: Date.now() - waitStart,
        });
      }
    };

    const onExit = () => doResolve(false);
    const onClose = () => doResolve(false);
    const onError = () => doResolve(false);

    child.on('exit', onExit);
    child.on('close', onClose);
    child.on('error', onError);

    if (timeoutMs > 0) {
      timer = setTimeout(() => doResolve(true), timeoutMs);
    }
  });
}

// ── Public API: startAndWait ──────────────────────────────────

export async function startAndWait(
  projectRoot: string,
  command: string,
  options: ProcessStartOptions,
  timeoutMs: number = 0,
): Promise<ProcessWaitResult> {
  const record = startProcess(projectRoot, command, options);
  return waitProcess(projectRoot, record.id, timeoutMs);
}

// ── Public API: tailOutput ────────────────────────────────────

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

// ── Public API: killProcess ───────────────────────────────────

export async function killProcess(
  projectRoot: string,
  procId: string,
  graceMs: number = 5000,
): Promise<ProcessRecord> {
  const child = activeProcesses.get(procId);

  if (!child) {
    const registry = loadRegistry(projectRoot);
    const record = registry.get(procId);
    if (!record) {
      throw new Error(`Process '${procId}' not found.`);
    }
    return record;
  }

  const currentStatus = resolveStatus(child);
  if (currentStatus !== 'running') {
    const registry = loadRegistry(projectRoot);
    const record = registry.get(procId);
    if (record) return record;
    throw new Error(`Process '${procId}' not found in registry.`);
  }

  const killed = child.kill('SIGTERM');
  if (!killed) {
    throw new Error(`Failed to send SIGTERM to process '${procId}'.`);
  }

  const waitResult = await waitProcess(projectRoot, procId, graceMs);

  if (waitResult.timedOut || waitResult.status === 'running') {
    const forcedKill = child.kill('SIGKILL');
    if (!forcedKill) {
      throw new Error(`Failed to send SIGKILL to process '${procId}'.`);
    }
    await waitProcess(projectRoot, procId, 2000);
  }

  // Allow microtask tick for exit handler to flush registry
  await new Promise((r) => setTimeout(r, 50));

  const registry = loadRegistry(projectRoot);
  const record = registry.get(procId);
  if (!record) {
    throw new Error(`Process '${procId}' not found in registry after kill.`);
  }

  return record;
}

// ── Public API: listProcesses ─────────────────────────────────

export function listProcesses(
  projectRoot: string,
  filter?: ProcessListFilter,
): ProcessRecord[] {
  const registry = loadRegistry(projectRoot);
  const records = Array.from(registry.values());

  // Merge in-memory state
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

// ── Public API: getProcess ────────────────────────────────────

export function getProcess(
  projectRoot: string,
  procId: string,
): ProcessRecord | null {
  const registry = loadRegistry(projectRoot);
  return registry.get(procId) ?? null;
}

// ── Public API: cleanupProcessOutput ──────────────────────────

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

// ── Public API: cleanupAllCompleted ───────────────────────────

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

// ── Public API: killAllRunning ────────────────────────────────

export async function killAllRunning(projectRoot: string): Promise<string[]> {
  const killedIds: string[] = [];

  for (const [procId, child] of activeProcesses) {
    try {
      await killProcess(projectRoot, procId);
      killedIds.push(procId);
    } catch {
      try {
        child.kill('SIGKILL');
        killedIds.push(procId);
      } catch { /* ignore */ }
    }
  }

  return killedIds;
}
