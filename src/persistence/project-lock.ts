import { mkdirSync, openSync, closeSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LockOwnershipError, LockTimeoutError } from './errors.js';

const LOCK_HANDLE_BRAND: unique symbol = Symbol('ProjectLockHandle');

export interface LockHandle {
  readonly acquired: true;
  readonly [LOCK_HANDLE_BRAND]: ProjectLock;
}

export interface ProjectLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ProjectLock {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private activeHandle: LockHandle | null = null;
  private asyncQueue: Promise<void> = Promise.resolve();
  private queuedAsyncCallCount = 0;

  constructor(readonly lockPath: string, options: ProjectLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 25;
  }

  withLockSync<T>(fn: (handle: LockHandle) => T): T {
    if (this.activeHandle || this.queuedAsyncCallCount > 0) {
      throw new LockTimeoutError(this.lockPath, 0);
    }

    mkdirSync(dirname(this.lockPath), { recursive: true });
    let fd: number | null = null;
    try {
      fd = openSync(this.lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }) + '\n', 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new LockTimeoutError(this.lockPath, 0);
      throw error;
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
          writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }) + '\n', 'utf-8');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST') throw error;
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
