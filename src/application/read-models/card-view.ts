import { PROJECT_CARD_ID, type CardStore } from '../../cards/store-api.js';
import { TERMINAL_STATUSES } from '../../permissions/index.js';
import type { CardOperatorSummary, CardRecord, CardView } from '../../schemas/index.js';

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
  return { ...card, display_path: computeCardDisplayPath(store, card), operator_summary: toCardOperatorSummary(card) };
}

export function toCardOperatorSummary(card: CardRecord): CardOperatorSummary {
  const lifecycle = card.lifecycle;
  return {
    lifecycleStatus: lifecycle.status,
    terminal: TERMINAL_STATUSES.has(lifecycle.status),
    needsVerification: lifecycle.status === 'needs_verification',
    blocked: lifecycle.status === 'blocked',
    hasError: Boolean(lifecycle.error),
    error: lifecycle.error ?? null,
    completedAt: lifecycle.completed_at ?? null,
    stale: lifecycle.status === 'changed',
    actionCount: card.allowedActions?.length ?? 0,
  };
}
