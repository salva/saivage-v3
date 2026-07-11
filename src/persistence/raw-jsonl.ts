import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PersistenceReadError, PersistenceValidationError, PersistenceWriteError } from './errors.js';

export function appendSyncIdempotentByKey<T extends Record<string, unknown>>(
  jsonlPath: string,
  entry: T,
  idField: keyof T & string,
): boolean {
  const entryId = entry[idField];
  if (typeof entryId !== 'string' || entryId.length === 0) {
    throw new PersistenceValidationError(jsonlPath, `id field '${idField}' must be a non-empty string`);
  }

  const content = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf-8') : '';
  if (content.length > 0 && !content.endsWith('\n')) {
    throw new PersistenceReadError(
      jsonlPath,
      `JSONL file has a partial tail; refusing to append ${idField}=${entryId}`,
    );
  }
  for (const line of content.split('\n').filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new PersistenceReadError(
        jsonlPath,
        `complete JSONL line is unparseable; refusing to append ${idField}=${entryId}`,
      );
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)[idField] === entryId) return false;
  }

  mkdirSync(dirname(jsonlPath), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, 'a');
    appendFileSync(fd, JSON.stringify(entry) + '\n', 'utf-8');
    fsyncSync(fd);
    return true;
  } catch (error) {
    throw new PersistenceWriteError(jsonlPath, (error as Error).message, { cause: error });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
