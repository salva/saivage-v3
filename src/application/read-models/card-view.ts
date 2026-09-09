import { PROJECT_CARD_ID, type CardService } from '../../cards/card-api.js';
import { cardViewSchema, type CardOperatorSummary, type CardRecord, type CardView } from '../../schemas/index.js';
import { cardParentId } from '../../schemas/card-id.js';
import { projectCardRecordForOutbound } from './card-outbound.js';

function computeCardLogicalPath(store: CardService, card: CardRecord): string | null {
  if (card.id === PROJECT_CARD_ID) return null;
  const segments = [String(siblingDisplayRank(store, card))];
  let parentId: string | null = cardParentId(card.id);
  while (parentId && parentId !== PROJECT_CARD_ID) {
    const parent: CardRecord | null = store.read(parentId);
    if (!parent) throw new Error(`Card topology corruption: missing parent ${parentId} for card ${card.id}`);
    segments.unshift(String(siblingDisplayRank(store, parent)));
    parentId = cardParentId(parent.id);
  }
  return segments.join('.');
}

function siblingDisplayRank(store: CardService, card: CardRecord): number {
  const parent = cardParentId(card.id);
  if (!parent) throw new Error(`Card topology corruption: card ${card.id} has no parent display rank`);
  const siblings = store.listChildren(parent);
  const index = siblings.indexOf(card.id);
  if (index === -1) throw new Error(`Card topology corruption: card ${card.id} is missing from parent ${parent} child index`);
  return index + 1;
}

export function toCardView(store: CardService, card: CardRecord): CardView {
  const projected = projectCardRecordForOutbound(card);
  return cardViewSchema.parse({ card: projected, logical_path: computeCardLogicalPath(store, card), status: projected.lifecycle.status, parent: cardParentId(card.id), operator_summary: toCardOperatorSummary(projected) });
}

function toCardOperatorSummary(card: Pick<CardRecord, 'lifecycle'>): CardOperatorSummary {
  const lifecycle = card.lifecycle;
  return {
    blocked: lifecycle.status === 'blocked',
    hasError: Boolean(lifecycle.error),
    error: lifecycle.error ?? null,
    completedAt: lifecycle.completed_at ?? null,
    stale: lifecycle.status === 'changed',
  };
}
