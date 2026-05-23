import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { PersistenceReadError, PersistenceValidationError, PersistenceVersionMismatch, PersistenceWriteError } from './errors.js';
import type { LockHandle } from './project-lock.js';
import { ProjectLock } from './project-lock.js';

export interface Cursor {
  readonly offset: number;
}

export interface JsonlLedgerOptions {
  version?: number | null;
}

type VersionedEnvelope<T> = { version: number; data: T };

function isVersionedEnvelope(value: unknown): value is VersionedEnvelope<unknown> {
  return Boolean(value && typeof value === 'object' && 'version' in value && 'data' in value);
}

function formatValidationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JsonlLedger<T> {
  private readonly version: number | null;
  private readonly quarantinePath: string;

  constructor(readonly path: string, private readonly schema: ZodType<T>, private readonly lock: ProjectLock, options: JsonlLedgerOptions = {}) {
    this.version = options.version === undefined ? 1 : options.version;
    this.quarantinePath = `${path}.quarantine`;
  }

  async append(handle: LockHandle, record: T): Promise<void> {
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

  async readAll(): Promise<T[]> {
    return (await this.readSince({ offset: 0 })).records;
  }

  async readSince(cursor: Cursor): Promise<{ records: T[]; nextCursor: Cursor }> {
    if (cursor.offset < 0 || !Number.isSafeInteger(cursor.offset)) {
      throw new PersistenceReadError(this.path, `invalid cursor offset ${cursor.offset}`);
    }
    if (!existsSync(this.path)) return { records: [], nextCursor: cursor };
    const raw = readFileSync(this.path, 'utf-8');
    const slice = raw.slice(cursor.offset);
    const baseLine = raw.slice(0, cursor.offset).split('\n').length;
    const records: T[] = [];
    let offset = cursor.offset;
    const lines = slice.split('\n');

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (index === lines.length - 1 && line === '') break;
      const lineStartOffset = offset;
      offset += Buffer.byteLength(line + '\n', 'utf-8');
      if (line.trim() === '') continue;
      try {
        records.push(this.parseLine(line));
      } catch (error) {
        this.quarantineLine({ lineNumber: baseLine + index, offset: lineStartOffset, line, error: formatValidationError(error) });
      }
    }

    return { records, nextCursor: { offset: raw.length } };
  }

  async *stream(): AsyncIterable<T> {
    for (const record of await this.readAll()) {
      yield record;
    }
  }

  private parseLine(line: string): T {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PersistenceReadError(this.path, 'malformed JSONL record', { cause: error });
    }
    const data = this.unwrapVersionedData(parsedJson);
    const parsed = this.schema.safeParse(data);
    if (!parsed.success) {
      throw new PersistenceValidationError(this.path, parsed.error.message);
    }
    return parsed.data;
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

  private quarantineLine(entry: { lineNumber: number; offset: number; line: string; error: string }): void {
    mkdirSync(dirname(this.quarantinePath), { recursive: true });
    appendFileSync(this.quarantinePath, JSON.stringify({ quarantined_at: new Date().toISOString(), source: this.path, line_number: entry.lineNumber, offset: entry.offset, error: entry.error, line: entry.line }) + '\n', 'utf-8');
  }
}
