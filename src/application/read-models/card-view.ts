import { PROJECT_CARD_ID, type CardStore } from '../../cards/store-api.js';
import type { CardRecord, CardView } from '../../schemas/index.js';

export function computeCardDisplayPath(store: CardStore, card: CardRecord): string | null {
  if (card.parent === null || card.id === PROJECT_CARD_ID) return null;
  const segments = [String(card.position + 1)];
  let parentId: string | null = card.parent;
  while (parentId && parentId !== PROJECT_CARD_ID) {
    const parent = store.read(parentId);
    if (!parent) break;
    segments.unshift(String(parent.position + 1));
    parentId = parent.parent;
  }
  return segments.join('.');
}

export function toCardView(store: CardStore, card: CardRecord): CardView {
  return { ...card, display_path: computeCardDisplayPath(store, card) };
}
