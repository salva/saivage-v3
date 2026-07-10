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
import { constants } from 'node:fs';
import { runtimeProcessLockFile } from '../persistence/layout.js';

// ── Types ─────────────────────────────────────────────────────

export interface LockPayload {
  pid: number;
  started_at: string;
}

export interface LockConfig {
  /** Maximum age in milliseconds before a lock is considered stale (default 14 days) */
  maxAgeMs: number;
  /** Lock file path (overridable for testing) */
  lockFilePath?: string;
}

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ── Constants ─────────────────────────────────────────────────

function lockPath(projectRoot: string, config?: LockConfig): string {
  if (config?.lockFilePath) return config.lockFilePath;
  return runtimeProcessLockFile(projectRoot);
}

function maxAge(config?: LockConfig): number {
  return config?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
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

// ── Public API ────────────────────────────────────────────────

/**
 * Attempt to acquire the exclusive runtime lock.
 *
 * Creates the lock file atomically using O_CREAT | O_EXCL.
 * The lock file contains JSON: { pid, started_at }.
 *
 * If the lock file already exists, checks for staleness:
 * - PID is dead, or
 * - Lock age exceeds the configured maxAgeMs (default 14 days).
 * If stale, removes the old lock and re-acquires.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 * @returns The LockPayload written to the lock file.
 * @throws If the lock is held by a live process and cannot be acquired.
 */
export function acquireLock(projectRoot: string, config?: LockConfig): LockPayload {
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
    return payload;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // File exists — check staleness
  }

  // Lock file exists — read it
  const raw = readFileSync(lp, 'utf-8');
  let existingPayload: LockPayload;
  try {
    existingPayload = JSON.parse(raw) as LockPayload;
  } catch {
    // Corrupt lock file — remove and retry
    unlinkSync(lp);
    return acquireLock(projectRoot, config);
  }

  const ageMs = Date.now() - new Date(existingPayload.started_at).getTime();
  const pidAlive = isPidAlive(existingPayload.pid);

  if (!pidAlive || ageMs > maxAge(config)) {
    // Stale — remove and retry
    removeStaleLock(projectRoot, config);
    return acquireLock(projectRoot, config);
  }

  // Lock is held by a live, recent process
  throw new Error(
    `Runtime lock is held by PID ${existingPayload.pid} (started ${existingPayload.started_at}). ` +
      `Cannot acquire lock while another instance is alive.`,
  );
}

/**
 * Release the runtime lock by deleting the lock file.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 */
export function releaseLock(projectRoot: string, config?: LockConfig): void {
  const lp = lockPath(projectRoot, config);
  // Gracefully handle missing parent directory
  if (!existsSync(dirname(lp))) return;
  if (existsSync(lp)) {
    unlinkSync(lp);
  }
}

/**
 * Check whether the runtime lock is currently held (by any process).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 * @returns true if the lock file exists and is not stale; false otherwise.
 */
export function isLocked(projectRoot: string, config?: LockConfig): boolean {
  const lp = lockPath(projectRoot, config);
  // If parent directory doesn't exist, lock can't exist
  if (!existsSync(dirname(lp))) return false;
  if (!existsSync(lp)) {
    return false;
  }

  let payload: LockPayload;
  try {
    const raw = readFileSync(lp, 'utf-8');
    payload = JSON.parse(raw) as LockPayload;
  } catch {
    // Corrupt lock file — treat as not locked (will be cleaned up by acquire)
    return false;
  }

  const ageMs = Date.now() - new Date(payload.started_at).getTime();
  const pidAlive = isPidAlive(payload.pid);

  if (!pidAlive || ageMs > maxAge(config)) {
    return false; // stale
  }

  return true;
}

/**
 * Remove the lock file if it is stale.
 * A lock is stale if the PID is dead or the lock is older than
 * the configured max age.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - Optional lock configuration.
 */
export function removeStaleLock(projectRoot: string, config?: LockConfig): void {
  const lp = lockPath(projectRoot, config);
  // Gracefully handle missing parent directory
  if (!existsSync(dirname(lp))) return;
  if (!existsSync(lp)) {
    return;
  }

  let payload: LockPayload;
  try {
    const raw = readFileSync(lp, 'utf-8');
    payload = JSON.parse(raw) as LockPayload;
  } catch {
    // Corrupt lock file — remove it
    unlinkSync(lp);
    return;
  }

  const ageMs = Date.now() - new Date(payload.started_at).getTime();
  const pidAlive = isPidAlive(payload.pid);

  if (!pidAlive || ageMs > maxAge(config)) {
    unlinkSync(lp);
  }
  // If PID is alive and within max age, do nothing (lock is valid)
}

export function readLiveLockHolder(projectRoot: string): { pid: number; started_at: string } | null {
  const path = lockPath(projectRoot);
  if (!existsSync(path)) return null;
  let payload: { pid: number; started_at: string };
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8')) as { pid: number; started_at: string };
  } catch {
    return null;
  }
  if (typeof payload.pid !== 'number' || !isPidAlive(payload.pid)) return null;
  return { pid: payload.pid, started_at: payload.started_at };
}
