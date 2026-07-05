import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse, CardDetailResponse } from '../api/types';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));

import { getCard, ApiError } from '../api/client';
import { useCardStore } from '../stores/cards';
import { selectChildrenOf } from '../stores/cards';

function setupStore() { setActivePinia(createPinia()); vi.clearAllMocks(); return useCardStore(); }
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord { const id = overrides.id || 'c1'; const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id, type: 'code', parent: null, depth: 0, position: 0, title: `Card ${id}`, status: 'running', tags: [], priority: 5, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], retries: 0, ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, needsVerification: lifecycle.status === 'needs_verification', blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }
function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mdr(card: CardRecord, children: CardRecord[] = [], ancestorIds: string[] = []): CardDetailResponse { return { card: { ...card, dependencyRefs: [], relatedRefs: [] }, children, ancestorIds, ancestorRefs: [] }; }

const A = makeCard({ id: 'card-a', title: 'Alpha' });

describe('useCardStore evidence support', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stores backend card detail and derives local lifecycle view state', async () => {
    const s = setupStore();
    const child = makeCard({ id: 'child-a', parent: 'card-a', status: 'running' });
    vi.mocked(getCard).mockResolvedValue(mdr(A, [child], []));
    await s.fetchCardDetail('card-a');
    expect(s.currentCard?.id).toBe('card-a');
    expect(s.currentChildren.map((card) => card.id)).toEqual(['child-a']);
    expect(s.currentLifecycle?.status).toBe('running');
    expect(s.currentLifecycle?.childCounts.running).toBe(1);
    expect(s.currentDispatches).toBeNull();
    expect(s.currentDetailFreshness.isStale).toBe(false);
  });

  it('records structured unauthorized detail error', async () => {
    const s = setupStore();
    vi.mocked(getCard).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    await expect(s.fetchCardDetail('card-a')).rejects.toBeTruthy();
    expect(s.currentDetailError).toEqual({ kind: 'unauthorized', status: 401, message: 'Unauthorized' });
  });

  it('reports per-card stale notifications through isStale', () => {
    const s = setupStore();
    s.setCardStaleNotification('card-a', true);
    s.setCardStaleNotification('card-b', false);
    expect(s.isStale('card-a')).toBe(true);
    expect(s.isStale('card-b')).toBe(false);
    expect(s.isStale('card-unknown')).toBe(false);
  });

  it('keeps child ordering in the pure card read-model selector, not the store public API', () => {
    const s = setupStore();
    s.cards = [
      makeCard({ id: 'c-e', parent: 'goal-a', position: 3 }),
      makeCard({ id: 'c-b', parent: 'goal-a', position: 1 }),
      makeCard({ id: 'c-d', parent: 'goal-a', position: undefined }),
      makeCard({ id: 'c-a', parent: 'goal-a', position: 1 }),
      makeCard({ id: 'c-c', parent: 'goal-a', position: 2 }),
      makeCard({ id: 'other', parent: 'goal-b', position: 0 }),
    ];
    expect(selectChildrenOf([...s.cards], 'goal-a').map((card) => card.id)).toEqual(['c-a', 'c-b', 'c-c', 'c-e', 'c-d']);
    expect(selectChildrenOf([...s.cards], 'goal-unknown')).toEqual([]);
    expect('childrenOf' in s).toBe(false);
  });
});
