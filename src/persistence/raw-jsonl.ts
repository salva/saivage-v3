import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PersistenceReadError, PersistenceValidationError, PersistenceWriteError } from './errors.js';

interface LastLineSyncResult {
  line: string | null;
  endsWithNewline: boolean;
  partialTail: string | null;
}

function lastLineSync(jsonlPath: string): LastLineSyncResult {
  if (!existsSync(jsonlPath)) return { line: null, endsWithNewline: true, partialTail: null };
  const buf = readFileSync(jsonlPath);
  if (buf.length === 0) return { line: null, endsWithNewline: true, partialTail: null };
  const endsWithNewline = buf[buf.length - 1] === 0x0a;
  if (endsWithNewline) {
    const end = buf.length - 1;
    if (end === 0) return { line: '', endsWithNewline: true, partialTail: null };
    let start = end - 1;
    while (start > 0 && buf[start - 1] !== 0x0a) start--;
    return { line: buf.slice(start, end).toString('utf-8'), endsWithNewline: true, partialTail: null };
  }
  const end = buf.length;
  let start = end - 1;
  while (start > 0 && buf[start - 1] !== 0x0a) start--;
  const partial = buf.slice(start, end).toString('utf-8');
  if (start === 0) return { line: null, endsWithNewline: false, partialTail: partial };
  const prevEnd = start - 1;
  let prevStart = prevEnd;
  while (prevStart > 0 && buf[prevStart - 1] !== 0x0a) prevStart--;
  return {
    line: buf.slice(prevStart, prevEnd).toString('utf-8'),
    endsWithNewline: false,
    partialTail: partial,
  };
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
