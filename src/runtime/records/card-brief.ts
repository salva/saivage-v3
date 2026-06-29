import { existsSync, readFileSync } from 'node:fs';
import type { CardRecord } from '../../schemas/index.js';
import { readRecordSlotIndex, recordPath } from './record-slots.js';

export function readLatestBriefRecord(projectRoot: string, cardId: string): string | null {
  const index = readRecordSlotIndex(projectRoot, cardId, 'brief');
  if (index.latest === null) return null;
  const path = recordPath(projectRoot, cardId, 'brief', index.latest, 'brief.md').absolutePath;
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function cardBriefForPrompt(projectRoot: string, card: CardRecord): string {
  const brief = readLatestBriefRecord(projectRoot, card.id);
  if (brief === null) throw new Error(`Card '${card.id}' is missing required brief.md record.`);
  return brief;
}
