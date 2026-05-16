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

export interface ProcessStartOptions {
  cardId: string;
  cwd?: string;
  env?: Record<string, string>;
  requiredForCardCompletion?: boolean;
  agentSessionId?: string;
  goalId?: string;
  launchReason?: string;
  ownerKind?: 'agent' | 'operator' | 'runtime';
  backgroundPolicy?: 'foreground' | 'background_required' | 'background_optional' | 'detach' | 'kill_on_freeze';
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

const PROCESSES_DIR = '.saivage-work/processes';
const REGISTRY_FILE = '.saivage/runtime/processes.json';

const activeProcesses = new Map<string, ChildProcess>();
const outputStreams = new Map<
  string,
  { stdout: WriteStream; stderr: WriteStream; combined: WriteStream }
>();
const pendingStreamCloses = new Map<string, number>();
const streamCloseWaiters = new Map<string, Promise<void>>();

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

function waitForProcessRecord(
  projectRoot: string,
  procId: string,
  predicate: (record: ProcessRecord) => boolean,
  timeoutMs: number,
): Promise<ProcessRecord | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      const record = getProcess(projectRoot, procId);
      if (record && predicate(record)) {
        cleanup();
        resolve(record);
        return;
      }
      if (Date.now() >= deadline) {
        cleanup();
        resolve(record ?? null);
      }
    };

    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };

    const interval = setInterval(check, 25);
    interval.unref();
    const timeout = setTimeout(check, timeoutMs);
    timeout.unref();
    check();
  });
}

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
  const closePromise = closeAllStreams(procId).finally(() => {
    streamCloseWaiters.delete(procId);
  });
  streamCloseWaiters.set(procId, closePromise);
  activeProcesses.delete(procId);
  pendingStreamCloses.delete(procId);
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
    process_group_id: child.pid ?? null,
  };

  upsertRegistryRecord(projectRoot, record);

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

    try {
      upsertRegistryRecord(projectRoot, updatedRecord);
    } catch {}

    const pending = pendingStreamCloses.get(id);
    if (pending !== undefined && pending <= 0) {
      finalizeProcess(id);
    }

    const cleanupTimer = setTimeout(() => {
      if (activeProcesses.has(id) || outputStreams.has(id)) {
        finalizeProcess(id);
      }
    }, 5000);
    cleanupTimer.unref();
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
      completed_at: now(),
    };

    finalizeProcess(id);

    try {
      upsertRegistryRecord(projectRoot, updatedRecord);
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
        void waitForDurableOutput(procId).finally(() => {
          resolve({
            id: procId,
            status: resolveStatus(child),
            exitCode: resolveExitCode(child),
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

    if (timeoutMs > 0) {
      timer = setTimeout(() => doResolve(true), timeoutMs);
    }
  });
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

  const killed = signalProcessTree(child, 'SIGTERM');
  if (!killed) {
    throw new Error(`Failed to send SIGTERM to process '${procId}'.`);
  }

  const waitResult = await waitProcess(projectRoot, procId, graceMs);

  if (waitResult.timedOut || waitResult.status === 'running') {
    const forcedKill = signalProcessTree(child, 'SIGKILL');
    if (!forcedKill) {
      throw new Error(`Failed to send SIGKILL to process '${procId}'.`);
    }
    await waitProcess(projectRoot, procId, 2000);
  }

  const record = await waitForProcessRecord(
    projectRoot,
    procId,
    (candidate) => candidate.status !== 'running',
    5000,
  );
  if (!record) {
    throw new Error(`Process '${procId}' not found in registry after kill.`);
  }

  return record;
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
      } catch {}
    }
  }

  return killedIds;
}
