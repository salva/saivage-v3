import { mkdirSync, openSync, closeSync, unlinkSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { LockOwnershipError, LockTimeoutError, StaleLockError } from './errors.js';

const LOCK_HANDLE_BRAND: unique symbol = Symbol('ProjectLockHandle');

export interface LockHandle {
  readonly acquired: true;
  readonly [LOCK_HANDLE_BRAND]: ProjectLock;
}

export interface ProjectLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleLockAction?: 'error' | 'remove';
}

export interface LockMetadata {
  pid: number;
  acquired_at: string;
  hostname: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.acquired_at !== 'string' || Number.isNaN(Date.parse(parsed.acquired_at))) return null;
    if (typeof parsed.hostname !== 'string' || parsed.hostname.length === 0) return null;
    return { pid: parsed.pid, acquired_at: parsed.acquired_at, hostname: parsed.hostname };
  } catch {
    return null;
  }
}

function writeLockMetadata(fd: number): void {
  const meta: LockMetadata = { pid: process.pid, acquired_at: new Date().toISOString(), hostname: hostname() };
  writeFileSync(fd, JSON.stringify(meta) + '\n', 'utf-8');
}

export class ProjectLock {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly staleLockAction: 'error' | 'remove';
  private activeHandle: LockHandle | null = null;
  private asyncQueue: Promise<void> = Promise.resolve();
  private queuedAsyncCallCount = 0;

  constructor(readonly lockPath: string, options: ProjectLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
    this.staleLockAction = options.staleLockAction ?? 'error';
  }

  withLockSync<T>(fn: (handle: LockHandle) => T): T {
    if (this.activeHandle || this.queuedAsyncCallCount > 0) {
      throw new LockTimeoutError(this.lockPath, 0);
    }

    mkdirSync(dirname(this.lockPath), { recursive: true });
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(this.lockPath, 'wx');
        writeLockMetadata(fd);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        const metadata = readLockMetadata(this.lockPath);
        if (!metadata) throw new StaleLockError(this.lockPath, null, 'invalid lock metadata');
        if (metadata.hostname !== hostname()) throw new StaleLockError(this.lockPath, metadata, 'lock belongs to a different host');
        if (isPidAlive(metadata.pid)) throw new LockTimeoutError(this.lockPath, 0);
        if (this.staleLockAction === 'error') throw new StaleLockError(this.lockPath, metadata, 'lock holder process is not alive');
        unlinkSync(this.lockPath);
      }
    }

    const handle = { acquired: true, [LOCK_HANDLE_BRAND]: this } as const satisfies LockHandle;
    this.activeHandle = handle;
    try {
      return fn(handle);
    } finally {
      this.activeHandle = null;
      closeSync(fd);
      try {
        if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
      } catch {
        // Advisory lock cleanup is best-effort after releasing this process's descriptor.
      }
    }
  }

  async withLock<T>(fn: (handle: LockHandle) => Promise<T>): Promise<T> {
    let releaseQueueSlot!: () => void;
    const queueSlot = new Promise<void>((resolve) => {
      releaseQueueSlot = resolve;
    });
    const previousQueue = this.asyncQueue;
    this.asyncQueue = previousQueue.then(() => queueSlot, () => queueSlot);
    this.queuedAsyncCallCount++;

    await previousQueue;

    mkdirSync(dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    let fd: number | null = null;

    try {
      while (fd === null) {
        try {
          fd = openSync(this.lockPath, 'wx');
          writeLockMetadata(fd);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST') throw error;
          const metadata = readLockMetadata(this.lockPath);
          if (!metadata) throw new StaleLockError(this.lockPath, null, 'invalid lock metadata');
          if (metadata.hostname !== hostname()) throw new StaleLockError(this.lockPath, metadata, 'lock belongs to a different host');
          if (!isPidAlive(metadata.pid)) {
            if (this.staleLockAction === 'error') throw new StaleLockError(this.lockPath, metadata, 'lock holder process is not alive');
            unlinkSync(this.lockPath);
            continue;
          }
          if (Date.now() >= deadline) throw new LockTimeoutError(this.lockPath, this.timeoutMs);
          await sleep(this.retryDelayMs);
        }
      }

      const handle = { acquired: true, [LOCK_HANDLE_BRAND]: this } as const satisfies LockHandle;
      this.activeHandle = handle;
      try {
        return await fn(handle);
      } finally {
        this.activeHandle = null;
        closeSync(fd);
        try {
          if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
        } catch {
          // Advisory lock cleanup is best-effort after releasing this process's descriptor.
        }
      }
    } finally {
      this.queuedAsyncCallCount--;
      releaseQueueSlot();
    }
  }

  assertOwns(handle: LockHandle): void {
    if (handle[LOCK_HANDLE_BRAND] !== this || this.activeHandle !== handle) {
      throw new LockOwnershipError();
    }
  }
}
