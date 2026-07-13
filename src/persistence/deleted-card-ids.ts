import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
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
