import type { CardRecord, CardStatus, CardType, DetailErrorState, DetailFreshnessState } from '../api/types';
import { ApiError } from '../api/client';

/** Presentation selectors for filtering, ordering, grouping, and UI detail-state projection of cards. */
export interface CardFilterState {
  status: CardStatus | '';
  type: CardType | '';
  parent: string;
  tag: string;
  query: string;
}

const CARD_STATUSES: CardStatus[] = ['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled', 'needs_verification'];

export function buildDetailError(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof ApiError) {
    if (err.isUnauthorized) {
      return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    }
    if (err.isNotFound) {
      return { kind: 'not-found', status: err.status, message: err.message || 'Card not found.' };
    }
    if (err.status >= 500) {
      return { kind: 'server', status: err.status, message: err.message || fallback };
    }
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) {
    return { kind: 'network', status: null, message: err.message || fallback };
  }
  return { kind: 'unknown', status: null, message: fallback };
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function buildTree(cards: CardRecord[]): CardRecord[] {
  const byId = new Map<string, CardRecord & { children?: CardRecord[] }>();
  const roots: CardRecord[] = [];

  for (const card of cards) {
    byId.set(card.id, { ...card, children: [] });
  }

  for (const card of byId.values()) {
    if (card.parent && byId.has(card.parent)) {
      const parent = byId.get(card.parent)!;
      if (!parent.children) parent.children = [];
      parent.children.push(card);
    } else {
      roots.push(card);
    }
  }

  return roots;
}

export function sortCards(a: CardRecord, b: CardRecord): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

export function sortCardsByParentPosition(a: CardRecord, b: CardRecord): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.id.localeCompare(b.id);
}

export function applyCardFilters(source: CardRecord[], filters: CardFilterState): CardRecord[] {
  let result = source;

  if (filters.status) result = result.filter((card) => card.status === filters.status);
  if (filters.type) result = result.filter((card) => card.type === filters.type);
  if (filters.tag) result = result.filter((card) => card.tags.includes(filters.tag));
  if (filters.query) {
    const q = filters.query.toLowerCase();
    result = result.filter((card) =>
      card.title.toLowerCase().includes(q)
      || card.description.toLowerCase().includes(q)
      || card.id.toLowerCase().includes(q));
  }
  if (filters.parent) result = result.filter((card) => card.parent === filters.parent);

  return result;
}

export function selectFilteredCards(source: CardRecord[], filters: CardFilterState): CardRecord[] {
  return [...applyCardFilters(source, filters)].sort(sortCards);
}

export function selectOrderedFilteredCards(source: CardRecord[], filters: CardFilterState): CardRecord[] {
  return applyCardFilters(source, filters);
}

export function selectBoardColumns(cards: CardRecord[]): Map<CardStatus, CardRecord[]> {
  const columns = new Map<CardStatus, CardRecord[]>();
  for (const status of CARD_STATUSES) columns.set(status, []);
  for (const card of cards) {
    const column = columns.get(card.status);
    if (column) column.push(card);
  }
  for (const column of columns.values()) column.sort(sortCards);
  return columns;
}

export function selectAvailableTags(cards: CardRecord[]): string[] {
  const tags = new Set<string>();
  for (const card of cards) {
    for (const tag of card.tags) {
      if (tag) tags.add(tag);
    }
  }
  return [...tags].sort();
}

export function selectChildrenOf(cards: CardRecord[], parentId: string): CardRecord[] {
  return cards.filter((card) => card.parent === parentId).slice().sort(sortCardsByParentPosition);
}

export function createFreshDetailState(nowIso: string): DetailFreshnessState {
  return {
    isStale: false,
    lastLoadedAt: nowIso,
    staleReason: null,
  };
}

export function createEmptyDetailState(): DetailFreshnessState {
  return {
    isStale: false,
    lastLoadedAt: null,
    staleReason: null,
  };
}

export function markDetailStaleState(state: DetailFreshnessState, reason: DetailFreshnessState['staleReason']): DetailFreshnessState {
  return {
    ...state,
    isStale: true,
    staleReason: reason,
  };
}
