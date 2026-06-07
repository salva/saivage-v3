import { PROJECT_CARD_ID, type CardStore } from '../../cards/store-api.js';
import { TERMINAL_STATUSES } from '../../permissions/index.js';
import type { CardOperatorSummary, CardRecord, CardRefView, CardView } from '../../schemas/index.js';

export function computeCardDisplayPath(store: CardStore, card: CardRecord): string | null {
  if (card.parent === null || card.id === PROJECT_CARD_ID) return null;
  const segments = [String(card.position + 1)];
  let parentId: string | null = card.parent;
  while (parentId && parentId !== PROJECT_CARD_ID) {
    const parent = store.read(parentId);
    if (!parent) throw new Error(`Card topology corruption: missing parent ${parentId} for card ${card.id}`);
    segments.unshift(String(parent.position + 1));
    parentId = parent.parent;
  }
  return segments.join('.');
}

export function orderedCardsForTree(store: CardStore): CardRecord[] {
  const all = store.list();
  const byId = new Map(all.map((card) => [card.id, card]));
  const result: CardRecord[] = [];
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    const card = byId.get(id);
    if (!card) throw new Error(`Card topology corruption: missing card ${id} during tree ordering`);
    visited.add(id);
    result.push(card);
    for (const childId of store.listChildren(id)) visit(childId);
  };

  if (byId.has(PROJECT_CARD_ID)) visit(PROJECT_CARD_ID);
  else for (const childId of store.listChildren(PROJECT_CARD_ID)) visit(childId);
  for (const card of all) {
    if (visited.has(card.id)) continue;
    if (card.parent && card.parent !== PROJECT_CARD_ID && !byId.has(card.parent)) throw new Error(`Card topology corruption: missing parent ${card.parent} for card ${card.id}`);
    if (card.parent === null) visit(card.id);
  }
  if (result.length !== all.length) throw new Error('Card topology corruption: tree ordering did not visit every card');
  return result;
}

export function toCardView(store: CardStore, card: CardRecord): CardView {
  return { ...card, display_path: computeCardDisplayPath(store, card), operator_summary: toCardOperatorSummary(card) };
}

export function toCardRefView(store: CardStore, id: string): CardRefView {
  const card = store.read(id);
  if (!card) return { id, display_path: null, title: null, missing: true };
  return { id, display_path: computeCardDisplayPath(store, card), title: card.title };
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
