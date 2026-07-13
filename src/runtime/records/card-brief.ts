import type { CardStore } from '../../cards/card-store.js';
import type { CardRecord } from '../../schemas/index.js';

export function readLatestBriefRecord(store: Pick<CardStore, 'readRecord'>, cardId: string): string | null {
  try { return store.readRecord(cardId, 'brief.md', 'latest').artifact.content; } catch { return null; }
}

export function cardBriefForPrompt(store: Pick<CardStore, 'readRecord'>, card: CardRecord): string {
  const brief = readLatestBriefRecord(store, card.id);
  if (brief === null) throw new Error(`Card '${card.id}' is missing required brief.md record.`);
  return brief;
}
