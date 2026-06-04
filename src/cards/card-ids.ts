import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function addIdsFromDir(target: Set<string>, dir: string, suffix: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(suffix)) continue;
    if (entry.includes('.tmp.')) continue;
    target.add(entry.slice(0, -suffix.length));
  }
}

export function collectReservedCardIds(projectRoot: string, liveIds: string[] = []): string[] {
  const ids = new Set(liveIds);
  addIdsFromDir(ids, join(projectRoot, '.saivage', 'cards', 'by-id'), '.json');
  addIdsFromDir(ids, join(projectRoot, '.saivage', 'cards', 'history'), '.history.jsonl');
  addIdsFromDir(ids, join(projectRoot, '.saivage', 'archive', 'cards'), '.json');
  return [...ids].sort();
}

export function isReservedCardId(projectRoot: string, cardId: string, liveIds: string[] = []): boolean {
  return collectReservedCardIds(projectRoot, liveIds).includes(cardId);
}
