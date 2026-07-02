import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { PersistenceValidationError, PersistenceWriteError } from './errors.js';
import type { LockHandle } from './project-lock.js';
import { ProjectLock } from './project-lock.js';

export interface JsonlLedgerOptions {
  version?: number | null;
}

export class JsonlLedger<T> {
  private readonly version: number | null;

  constructor(readonly path: string, private readonly schema: ZodType<T>, private readonly lock: ProjectLock, options: JsonlLedgerOptions = {}) {
    this.version = options.version === undefined ? 1 : options.version;
  }

  appendSync(handle: LockHandle, record: T): void {
    this.lock.assertOwns(handle);
    const parsed = this.schema.safeParse(record);
    if (!parsed.success) {
      throw new PersistenceValidationError(this.path, parsed.error.message);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'a');
      appendFileSync(fd, JSON.stringify(this.wrapVersionedData(parsed.data)) + '\n', 'utf-8');
      fsyncSync(fd);
    } catch (error) {
      throw new PersistenceWriteError(this.path, (error as Error).message, { cause: error });
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  private wrapVersionedData(value: T): unknown {
    return this.version === null ? value : { version: this.version, data: value };
  }
}
