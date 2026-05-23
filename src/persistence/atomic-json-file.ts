import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';
import { PersistenceReadError, PersistenceValidationError, PersistenceVersionMismatch, PersistenceWriteError } from './errors.js';
import type { LockHandle } from './project-lock.js';
import { ProjectLock } from './project-lock.js';

export interface AtomicJsonFileOptions {
  version?: number | null;
}

type VersionedEnvelope<T> = { version: number; data: T };

function isVersionedEnvelope(value: unknown): value is VersionedEnvelope<unknown> {
  return Boolean(value && typeof value === 'object' && 'version' in value && 'data' in value);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Some platforms/filesystems do not allow directory fsync; file fsync + rename still preserves atomicity.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export class AtomicJsonFile<T> {
  private readonly version: number | null;

  constructor(readonly path: string, private readonly schema: ZodType<T>, private readonly lock: ProjectLock, options: AtomicJsonFileOptions = {}) {
    this.version = options.version === undefined ? 1 : options.version;
  }

  read(): T {
    if (!existsSync(this.path)) {
      throw new PersistenceReadError(this.path, 'file does not exist');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
    } catch (error) {
      throw new PersistenceReadError(this.path, 'malformed JSON; reset .saivage runtime state and restart', { cause: error });
    }

    const data = this.unwrapVersionedData(parsedJson);
    const parsed = this.schema.safeParse(data);
    if (!parsed.success) {
      throw new PersistenceValidationError(this.path, parsed.error.message);
    }
    return parsed.data;
  }

  writeSync(handle: LockHandle, value: T): void {
    this.lock.assertOwns(handle);
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new PersistenceValidationError(this.path, parsed.error.message);
    }
    this.writeJson(parsed.data);
  }

  async write(handle: LockHandle, value: T): Promise<void> {
    this.writeSync(handle, value);
  }

  updateSync(handle: LockHandle, fn: (cur: T) => T): T {
    this.lock.assertOwns(handle);
    const next = fn(this.read());
    this.writeSync(handle, next);
    return next;
  }

  async update(handle: LockHandle, fn: (cur: T) => T): Promise<T> {
    return this.updateSync(handle, fn);
  }

  private unwrapVersionedData(value: unknown): unknown {
    if (this.version === null) return value;
    if (!isVersionedEnvelope(value)) {
      throw new PersistenceVersionMismatch(this.path, this.version, 'missing');
    }
    if (value.version !== this.version) {
      throw new PersistenceVersionMismatch(this.path, this.version, value.version);
    }
    return value.data;
  }

  private wrapVersionedData(value: T): unknown {
    return this.version === null ? value : { version: this.version, data: value };
  }

  private writeJson(value: T): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const suffix = randomBytes(8).toString('hex');
    const tmpPath = `${this.path}.tmp.${suffix}`;
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, 'w');
      writeFileSync(fd, JSON.stringify(this.wrapVersionedData(value), null, 2) + '\n', 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmpPath, this.path);
      fsyncDirectory(dir);
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Preserve the original write failure.
      }
      throw new PersistenceWriteError(this.path, (error as Error).message, { cause: error });
    }
  }
}
