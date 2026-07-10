import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeFileSyncDurable } from './durable-write.js';
import { deletedCardIdsFile } from './layout.js';

const deletedCardIdsSchema = z.array(z.string().min(1));

function normalizeIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

export function readDeletedCardIds(projectRoot: string): string[] {
  const path = deletedCardIdsFile(projectRoot);
  if (!existsSync(path)) return [];
  const parsed = deletedCardIdsSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
  return normalizeIds(parsed);
}

export function writeDeletedCardIds(projectRoot: string, ids: Iterable<string>): string[] {
  const normalized = normalizeIds(ids);
  writeFileSyncDurable(deletedCardIdsFile(projectRoot), JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

export function reserveDeletedCardIds(projectRoot: string, ids: Iterable<string>): string[] {
  return writeDeletedCardIds(projectRoot, [...readDeletedCardIds(projectRoot), ...ids]);
}
