import type { CardService } from '../../cards/card-service.js';
import type { CardRecord } from '../../schemas/index.js';
import { AuthoredRecordNotFoundError } from '../../persistence/authored-record-files.js';

export function readLatestBriefRecord(store: Pick<CardService, 'readRecord'>, cardId: string): string | null {
  try { return store.readRecord(cardId, 'brief.md', 'latest').artifact.content; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return null; throw error; }
}

export function cardBriefForPrompt(store: Pick<CardService, 'readRecord'>, card: CardRecord): string {
  const brief = readLatestBriefRecord(store, card.id);
  if (brief === null) throw new Error(`Card '${card.id}' is missing required brief.md record.`);
  return brief;
}
