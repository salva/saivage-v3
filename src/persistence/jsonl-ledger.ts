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
    this.appendSync(handle, record);
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

  async readAll(): Promise<T[]> {
    return this.readAllSync();
  }

  readAllSync(): T[] {
    return this.readSinceSync({ offset: 0 }).records;
  }

  async readSince(cursor: Cursor): Promise<{ records: T[]; nextCursor: Cursor }> {
    return this.readSinceSync(cursor);
  }

  readSinceSync(cursor: Cursor): { records: T[]; nextCursor: Cursor } {
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

// F13 r5 §"JSONL crash semantics" — raw (non-versioned) JSONL helpers for the
// card history files. These bypass the JsonlLedger version envelope because
// per-card history files store CardHistoryEntry rows directly.

export interface LastLineSyncResult {
  line: string | null;
  endsWithNewline: boolean;
  partialTail: string | null;
}

export function lastLineSync(jsonlPath: string): LastLineSyncResult {
  if (!existsSync(jsonlPath)) return { line: null, endsWithNewline: true, partialTail: null };
  const buf = readFileSync(jsonlPath);
  if (buf.length === 0) return { line: null, endsWithNewline: true, partialTail: null };
  const endsWithNewline = buf[buf.length - 1] === 0x0a;
  if (endsWithNewline) {
    // Last complete line is between the previous \n and the trailing \n.
    const end = buf.length - 1;
    if (end === 0) return { line: '', endsWithNewline: true, partialTail: null };
    let start = end - 1;
    while (start > 0 && buf[start - 1] !== 0x0a) start--;
    return { line: buf.slice(start, end).toString('utf-8'), endsWithNewline: true, partialTail: null };
  }
  // No trailing newline → partial last line. Find boundary before that partial tail.
  const end = buf.length;
  let start = end - 1;
  while (start > 0 && buf[start - 1] !== 0x0a) start--;
  const partial = buf.slice(start, end).toString('utf-8');
  if (start === 0) return { line: null, endsWithNewline: false, partialTail: partial };
  // Find the previous complete line for context.
  const prevEnd = start - 1;
  let prevStart = prevEnd;
  while (prevStart > 0 && buf[prevStart - 1] !== 0x0a) prevStart--;
  return {
    line: buf.slice(prevStart, prevEnd).toString('utf-8'),
    endsWithNewline: false,
    partialTail: partial,
  };
}

export function appendSyncIdempotent(
  jsonlPath: string,
  entry: { entry_id: string } & Record<string, unknown>,
): void {
  const tail = lastLineSync(jsonlPath);
  if (tail.line !== null) {
    let parsed: { entry_id?: unknown } | null = null;
    try {
      parsed = JSON.parse(tail.line) as { entry_id?: unknown };
    } catch {
      throw new PersistenceReadError(
        jsonlPath,
        `last complete JSONL line is unparseable; refusing to append entry_id=${entry.entry_id}`,
      );
    }
    if (parsed && parsed.entry_id === entry.entry_id) return;
  }
  mkdirSync(dirname(jsonlPath), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, 'a');
    appendFileSync(fd, JSON.stringify(entry) + '\n', 'utf-8');
    fsyncSync(fd);
  } catch (error) {
    throw new PersistenceWriteError(jsonlPath, (error as Error).message, { cause: error });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function appendSyncIdempotentByKey<T extends Record<string, unknown>>(
  jsonlPath: string,
  entry: T,
  idField: keyof T & string,
): void {
  const entryId = entry[idField];
  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new PersistenceValidationError(jsonlPath, `id field '${idField}' must be a non-empty string`);
  }

  const tail = lastLineSync(jsonlPath);
  if (!tail.endsWithNewline) {
    throw new PersistenceReadError(
      jsonlPath,
      `JSONL file has a partial tail; refusing to append ${idField}=${entryId}`,
    );
  }
  if (tail.line !== null) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(tail.line) as Record<string, unknown>;
    } catch {
      throw new PersistenceReadError(
        jsonlPath,
        `last complete JSONL line is unparseable; refusing to append ${idField}=${entryId}`,
      );
    }
    if (parsed && parsed[idField] === entryId) return;
  }

  mkdirSync(dirname(jsonlPath), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, 'a');
    appendFileSync(fd, JSON.stringify(entry) + '\n', 'utf-8');
    fsyncSync(fd);
  } catch (error) {
    throw new PersistenceWriteError(jsonlPath, (error as Error).message, { cause: error });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
