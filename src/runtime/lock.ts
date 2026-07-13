import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { constants } from 'node:fs';
import { runtimeProcessLockFile } from '../persistence/layout.js';

// ── Types ─────────────────────────────────────────────────────

export interface LockPayload {
  pid: number;
  started_at: string;
}

export interface LockConfig {
  /** Lock file path (overridable for testing) */
  lockFilePath?: string;
}

declare const runtimeLifecycleLockHandleBrand: unique symbol;

/** Opaque proof of one live runtime-lock acquisition. */
export interface RuntimeLifecycleLockHandle {
  readonly [runtimeLifecycleLockHandleBrand]: never;
}

interface RuntimeLifecycleLockOwnership {
  active: boolean;
  canonicalProjectRoot: string;
  lockFilePath: string;
}

const runtimeLifecycleLockOwnership = new WeakMap<object, RuntimeLifecycleLockOwnership>();

type LockState =
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'valid'; payload: LockPayload };

// ── Constants ─────────────────────────────────────────────────

function lockPath(projectRoot: string, config?: LockConfig): string {
  if (config?.lockFilePath) return config.lockFilePath;
  return runtimeProcessLockFile(projectRoot);
}

// ── PID Check ─────────────────────────────────────────────────

/**
 * Check whether a PID is alive on the current system.
 * Sends signal 0 (null signal) to test process existence.
 */
function isPidAlive(pid: number): boolean {
  try {
    // kill(pid, 0) checks existence without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Lock Payload Reading ───────────────────────────────────────

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function parseLockPayload(raw: string): LockPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return null;
  if (typeof candidate.started_at !== 'string') return null;
  const parsed = new Date(candidate.started_at);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== candidate.started_at) return null;
  return { pid: candidate.pid as number, started_at: candidate.started_at };
}

function readLockState(projectRoot: string, config?: LockConfig): LockState {
  const lp = lockPath(projectRoot, config);
  let raw: string;
  try {
    raw = readFileSync(lp, 'utf-8');
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { kind: 'missing' };
    const code = isErrnoException(err) && err.code ? ` (${err.code})` : '';
    throw new Error(`Cannot read runtime lock '${lp}'${code}; refusing to proceed while lock ownership is unknown.`);
  }

  const payload = parseLockPayload(raw);
  return payload === null ? { kind: 'malformed' } : { kind: 'valid', payload };
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'ENOENT') return;
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Attempt to acquire the exclusive runtime lock.
 *
 * Creates the lock file atomically using O_CREAT | O_EXCL.
 * The lock file contains JSON: { pid, started_at }.
 *
 * If the lock file already exists, removes only malformed lock files and
 * valid locks whose PID is dead, then re-acquires. A valid lock naming a live
 * PID blocks regardless of age. Existing lock files that cannot be read fail
 * closed and are left untouched.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 * @returns Opaque live ownership proof bound to this canonical project root.
 * @throws If the lock is held by a live process and cannot be acquired.
 */
export function acquireLock(projectRoot: string, config?: LockConfig): RuntimeLifecycleLockHandle {
  const lp = lockPath(projectRoot, config);

  // Ensure parent directory exists before attempting O_EXCL
  mkdirSync(dirname(lp), { recursive: true });

  // First, try to acquire directly with O_EXCL
  try {
    const payload: LockPayload = {
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    const fd = openSync(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeSync(fd, JSON.stringify(payload, null, 2) + '\n');
    closeSync(fd);
    const handle = {} as RuntimeLifecycleLockHandle;
    runtimeLifecycleLockOwnership.set(handle, {
      active: true,
      canonicalProjectRoot: realpathSync(projectRoot),
      lockFilePath: lp,
    });
    return handle;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // File exists — check staleness
  }

  const state = readLockState(projectRoot, config);
  if (state.kind === 'missing') {
    return acquireLock(projectRoot, config);
  }
  if (state.kind === 'malformed') {
    unlinkIfPresent(lp);
    return acquireLock(projectRoot, config);
  }

  if (!isPidAlive(state.payload.pid)) {
    unlinkIfPresent(lp);
    return acquireLock(projectRoot, config);
  }

  throw new Error(
    `Runtime lock is held by live PID ${state.payload.pid} (started ${state.payload.started_at}). ` +
      `Cannot acquire lock while another instance is alive.`,
  );
}

/**
 * Release the runtime lock by deleting the lock file.
 *
 * Releasing invalidates the handle even when the lock file is already absent.
 */
export function releaseLock(handle: RuntimeLifecycleLockHandle): void {
  const ownership = runtimeLifecycleLockOwnership.get(handle);
  if (!ownership?.active) throw new Error('Runtime lifecycle lock handle is foreign or already released.');
  const lp = ownership.lockFilePath;
  // Gracefully handle missing parent directory
  if (!existsSync(dirname(lp))) {
    ownership.active = false;
    return;
  }
  if (existsSync(lp)) {
    unlinkSync(lp);
  }
  ownership.active = false;
}

export function assertRuntimeLifecycleLock(
  handle: RuntimeLifecycleLockHandle,
  projectRoot: string,
): void {
  const ownership = runtimeLifecycleLockOwnership.get(handle);
  if (!ownership?.active) throw new Error('A live runtime lifecycle lock handle is required.');
  const canonicalProjectRoot = realpathSync(projectRoot);
  if (ownership.canonicalProjectRoot !== canonicalProjectRoot) {
    throw new Error(
      `Runtime lifecycle lock belongs to '${ownership.canonicalProjectRoot}', not '${canonicalProjectRoot}'.`,
    );
  }
}

/**
 * Check whether the runtime lock is currently held (by any process).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 * @returns true if the lock file contains a valid payload naming a live PID.
 */
export function isLocked(projectRoot: string, config?: LockConfig): boolean {
  const state = readLockState(projectRoot, config);
  return state.kind === 'valid' && isPidAlive(state.payload.pid);
}

/**
 * Remove a malformed lock file or a valid lock whose PID is dead.
 * Valid locks naming live PIDs are never removed due to age.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 */
export function removeStaleLock(projectRoot: string, config?: LockConfig): void {
  const lp = lockPath(projectRoot, config);
  const state = readLockState(projectRoot, config);
  if (state.kind === 'missing') return;
  if (state.kind === 'malformed') {
    unlinkIfPresent(lp);
    return;
  }

  if (!isPidAlive(state.payload.pid)) unlinkIfPresent(lp);
}

export function readLiveLockHolder(projectRoot: string, config?: LockConfig): { pid: number; started_at: string } | null {
  const state = readLockState(projectRoot, config);
  if (state.kind !== 'valid' || !isPidAlive(state.payload.pid)) return null;
  return { pid: state.payload.pid, started_at: state.payload.started_at };
}
