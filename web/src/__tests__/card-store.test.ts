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
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord { const id = overrides.id || '11111111-1111-4111-8111-111111111111'; const lifecycle = overrides.lifecycle ?? { status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']; return { id, type: 'code', parent: null, depth: 0, position: 0, title: `Card ${id}`, status: 'running', tags: [], priority: 5, urgency: 'normal', created_by: 'user', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', version_seq: 1, depends_on: [], related: [], pending_notifications: [], ...overrides, display_path: overrides.display_path ?? null, lifecycle, operator_summary: overrides.operator_summary ?? { lifecycleStatus: lifecycle.status, terminal: false, blocked: lifecycle.status === 'blocked', hasError: Boolean(lifecycle.error), error: lifecycle.error ?? null, completedAt: lifecycle.completed_at ?? null, stale: lifecycle.status === 'changed', actionCount: 0 } }; }
function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mdr(card: CardRecord, children: CardRecord[] = []): CardDetailResponse { return { card, children }; }

const A = makeCard({ id: '11111111-1111-4111-8111-111111111111', title: 'Alpha' });

describe('useCardStore evidence support', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('stores backend card detail and derives local lifecycle view state', async () => {
    const s = setupStore();
    const child = makeCard({ id: '22222222-2222-4222-8222-222222222222', parent: A.id, status: 'running' });
    vi.mocked(getCard).mockResolvedValue(mdr(A, [child]));
    await s.fetchCardDetail(A.id);
    expect(s.currentCard?.id).toBe(A.id);
    expect(s.currentChildren.map((card) => card.id)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(s.currentLifecycle?.status).toBe('running');
    expect(s.currentLifecycle?.childCounts.running).toBe(1);
    expect(s.currentDispatches).toBeNull();
    expect(s.currentDetailFreshness.isStale).toBe(false);
  });

  it('records structured unauthorized detail error', async () => {
    const s = setupStore();
    vi.mocked(getCard).mockRejectedValue(new ApiError(401, 'Unauthorized', {}));
    await expect(s.fetchCardDetail(A.id)).rejects.toBeTruthy();
    expect(s.currentDetailError).toEqual({ kind: 'unauthorized', status: 401, message: 'Unauthorized' });
  });

  it('reports per-card stale notifications through isStale', () => {
    const s = setupStore();
    s.setCardStaleNotification(A.id, true);
    s.setCardStaleNotification('22222222-2222-4222-8222-222222222222', false);
    expect(s.isStale(A.id)).toBe(true);
    expect(s.isStale('22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(s.isStale('33333333-3333-4333-8333-333333333333')).toBe(false);
  });

  it('keeps child ordering in the pure card read-model selector, not the store public API', () => {
    const s = setupStore();
    s.cards = [
      makeCard({ id: '55555555-5555-4555-8555-555555555555', parent: '11111111-1111-4111-8111-111111111111', position: 3 }),
      makeCard({ id: '22222222-2222-4222-8222-222222222222', parent: '11111111-1111-4111-8111-111111111111', position: 1 }),
      makeCard({ id: '44444444-4444-4444-8444-444444444444', parent: '11111111-1111-4111-8111-111111111111', position: undefined }),
      makeCard({ id: '11111111-1111-4111-8111-111111111112', parent: '11111111-1111-4111-8111-111111111111', position: 1 }),
      makeCard({ id: '33333333-3333-4333-8333-333333333333', parent: '11111111-1111-4111-8111-111111111111', position: 2 }),
      makeCard({ id: '66666666-6666-4666-8666-666666666666', parent: '77777777-7777-4777-8777-777777777777', position: 0 }),
    ];
    expect(selectChildrenOf([...s.cards], '11111111-1111-4111-8111-111111111111').map((card) => card.id)).toEqual(['11111111-1111-4111-8111-111111111112', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444']);
    expect(selectChildrenOf([...s.cards], '88888888-8888-4888-8888-888888888888')).toEqual([]);
    expect('childrenOf' in s).toBe(false);
  });
});
