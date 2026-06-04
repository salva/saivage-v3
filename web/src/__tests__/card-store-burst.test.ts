/**
 * Burst-mutation coverage for the card store WebSocket integration.
 *
 * Simulates rapid/overlapping WebSocket card mutation events and verifies
 * that the final card list and total remain consistent — no duplicates,
 * no stale card state, and no total mismatch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse } from '../api/types';

// --- API client mock ---
vi.mock('../api/client', () => ({
  listCards: vi.fn(),
  getCard: vi.fn(),
  
 
 
  ApiError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

import { listCards } from '../api/client';

// --- WS mock (mirrors pattern in card-store.test.ts) ---
const wsTypeHandlers = new Map<string, Set<(e: any) => void>>();
function fireWsEvent(type: string, content: Record<string, unknown>) {
  const hs = wsTypeHandlers.get(type);
  if (hs) for (const h of hs) h({ type, content });
}
vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    onType: (type: string, handler: (e: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  })),
}));

// --- Module under test ---
import { useCardStore } from '../stores/cards';

// --- Helpers ---
function setupStore() {
  setActivePinia(createPinia());
  wsTypeHandlers.clear();
  vi.clearAllMocks();
  return useCardStore();
}

function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const id =
    overrides.id || `c-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    type: 'code',
    parent: null,
    depth: 0,
    position: 0,
    title: `Card ${id}`,
    description: 'test',
    status: 'active',
    tags: [],
    priority: 5,
    urgency: 'normal',
    created_by: 'user',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    version_seq: 1,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    ...overrides,
    lifecycle: (overrides.lifecycle ?? { status: overrides.status ?? 'active', result: null, error: null, completed_at: null }) as CardRecord['lifecycle'],
  } as CardRecord;
}

function mlr(cards: CardRecord[], total?: number): CardListResponse {
  return { cards, total: total ?? cards.length };
}

const F1 = makeCard({ id: 'card-f1', title: 'Burst Alpha', type: 'code', status: 'active', priority: 10 });
const F2 = makeCard({ id: 'card-f2', title: 'Burst Beta', type: 'test', status: 'backlog', priority: 7 });
const F3 = makeCard({ id: 'card-f3', title: 'Burst Gamma', type: 'doc', status: 'drafting', priority: 5 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('card-store WS burst consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsTypeHandlers.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Scenario 1: Rapid create/create/update/delete with out-of-order fetches ──
  it('maintains consistent list & total after create/create/update/delete burst with stale fetch overwrite', async () => {
    const s = setupStore();

    // Pre-populate with one card so total starts at 1.
    vi.mocked(listCards).mockResolvedValue(mlr([F1]));
    await s.fetchCards();
    expect(s.cards).toHaveLength(1);
    expect(s.total).toBe(1);

    s.setupWsListener();

    // We'll control the background fetchCards resolution order.
    // The fix uses a generation counter: each optimistic mutation bumps the
    // generation, and a background fetch only applies if generation hasn't
    // changed since the fetch was initiated.
    //
    // Stale fetches (from older mutations) must be discarded.

    const F2_upd = { ...F2, title: 'Burst Beta Updated', priority: 99 };

    const deferreds: Array<{
      resolve: (v: CardListResponse) => void;
      reject: (e: Error) => void;
    }> = [];

    const mockedListCards = vi.mocked(listCards);
    mockedListCards.mockReset();

    let callIndex = 0;
    mockedListCards.mockImplementation(() => {
      const idx = callIndex++;
      return new Promise<CardListResponse>((resolve, reject) => {
        deferreds[idx] = { resolve, reject };
      });
    });

    // --- Fire events rapidly ---

    // 1) card-created F2 → optimistic [F2, F1], total=2, gen bumped, background fetch call#0
    fireWsEvent('activity', { event: 'card-created', card: F2 });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f2', 'card-f1']);
    expect(s.total).toBe(2);

    // 2) card-created F3 → optimistic [F3, F2, F1], total=3, gen bumped, background fetch call#1
    fireWsEvent('activity', { event: 'card-created', card: F3 });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f3', 'card-f2', 'card-f1']);
    expect(s.total).toBe(3);

    // 3) card-updated F2 → updates in-place, gen bumped, background fetch call#2
    fireWsEvent('activity', { event: 'card-updated', card: F2_upd });
    expect(s.cards.find((c) => c.id === 'card-f2')?.title).toBe('Burst Beta Updated');

    // 4) card-deleted F2 → removes F2, total=2, gen bumped, background fetch call#3
    fireWsEvent('activity', { event: 'card-deleted', id: 'card-f2' });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f3', 'card-f1']);
    expect(s.total).toBe(2);

    // Now resolve the background fetches in deliberately bad order.
    // call#0 (from create F2): gen at start was gen=1, current gen is gen=4 → STALE, discard
    // call#1 (from create F3): gen at start was gen=2, current gen is gen=4 → STALE, discard
    // call#2 (from update F2): gen at start was gen=3, current gen is gen=4 → STALE, discard
    // call#3 (from delete F2): gen at start was gen=4, current gen is gen=4 → FRESH, apply

    // Resolve the stale fetches first (they must be discarded by the gen guard)
    deferreds[0].resolve(mlr([F1, F2])); // stale: gen=1 vs current=4
    deferreds[1].resolve(mlr([F1, F2, F3])); // stale: gen=2 vs current=4
    deferreds[2].resolve(mlr([F1, F2_upd, F3])); // stale: gen=3 vs current=4

    // Wait for microtasks
    await vi.waitFor(() => {}, { timeout: 1000 });

    // After stale fetches resolve, state should be unchanged (gen guard discarded them)
    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f3']);
    expect(s.total).toBe(2);
    expect(s.cards.find((c) => c.id === 'card-f2')).toBeUndefined();

    // Now resolve the fresh fetch (call#3, from delete F2) — gen matches, should apply
    deferreds[3].resolve(mlr([F1, F3]));

    await vi.waitFor(() => {}, { timeout: 1000 });

    // Final state: only F1 and F3
    const ids = s.cards.map((c) => c.id).sort();
    expect(ids).toEqual(['card-f1', 'card-f3']);
    expect(s.total).toBe(2);
    expect(s.cards.find((c) => c.id === 'card-f2')).toBeUndefined();
    expect(s.cards.find((c) => c.id === 'card-f3')).toBeDefined();

    // No duplicates
    const idSet = new Set(ids);
    expect(idSet.size).toBe(ids.length);
  });

  // ── Scenario 2: Gen guard discards a fetch from a superseded mutation ──
  it('discards a background fetch from a superseded mutation when a newer mutation arrives before fetch resolution', async () => {
    const s = setupStore();

    // Start with F1 and F2
    vi.mocked(listCards).mockResolvedValue(mlr([F1, F2]));
    await s.fetchCards();
    expect(s.cards).toHaveLength(2);
    expect(s.total).toBe(2);

    s.setupWsListener();

    // Control fetch resolution order
    const deferreds: Array<{
      resolve: (v: CardListResponse) => void;
      reject: (e: Error) => void;
    }> = [];
    let callIdx = 0;
    const mockedListCards = vi.mocked(listCards);
    mockedListCards.mockReset();
    mockedListCards.mockImplementation(() => {
      const idx = callIdx++;
      return new Promise<CardListResponse>((resolve, reject) => {
        deferreds[idx] = { resolve, reject };
      });
    });

    // --- Step 1: Delete F2 via WS.  Optimistic removal bumps gen to 1.
    //             Background fetch call#0 is dispatched.
    fireWsEvent('activity', { event: 'card-deleted', id: 'card-f2' });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f1']);
    expect(s.total).toBe(1);

    // --- Step 2: Before call#0 resolves, create F3 via WS.
    //             This bumps gen to 2 and dispatches background fetch call#1.
    fireWsEvent('activity', { event: 'card-created', card: F3 });
    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f3']);
    expect(s.total).toBe(2);

    // --- Step 3: Resolve call#0 (from delete, gen=1).
    //             Current gen is 2, so this response MUST be discarded.
    //             It returns stale server data that still includes F2.
    deferreds[0].resolve(mlr([F1, F2]));

    await vi.waitFor(() => {}, { timeout: 500 });

    // The stale fetch (call#0) must NOT overwrite state.
    // F3 must still be present, F2 must still be absent.
    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f3']);
    expect(s.total).toBe(2);
    expect(s.cards.find((c) => c.id === 'card-f2')).toBeUndefined();
    expect(s.cards.find((c) => c.id === 'card-f3')).toBeDefined();

    // --- Step 4: Resolve call#1 (from create F3, gen=2).
    //             Current gen is still 2, so this response applies.
    deferreds[1].resolve(mlr([F1, F3]));

    await vi.waitFor(() => {}, { timeout: 500 });

    // Final state: consistent — F1 and F3 only, no F2.
    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f3']);
    expect(s.total).toBe(2);
    expect(s.cards.find((c) => c.id === 'card-f2')).toBeUndefined();
  });

  // ── Scenario 3: Rapid duplicate creates must not add the same card twice ──
  it('deduplicates rapid card-created events for the same card id', () => {
    const s = setupStore();
    s.setupWsListener();

    fireWsEvent('activity', { event: 'card-created', card: F1 });
    fireWsEvent('activity', { event: 'card-created', card: F1 });
    fireWsEvent('activity', { event: 'card-created', card: F1 });

    expect(s.cards).toHaveLength(1);
    expect(s.total).toBe(1);
    expect(s.cards[0].id).toBe('card-f1');
  });

  // ── Scenario 4: Concurrent create and update for the same card ──
  it('handles create then immediate update for the same card consistently', () => {
    const s = setupStore();
    s.cards = [F1];
    s.total = 1;
    s.setupWsListener();

    fireWsEvent('activity', { event: 'card-created', card: F2 });
    const F2_upd = { ...F2, title: 'Burst Beta v2', status: 'done' as const };
    fireWsEvent('activity', { event: 'card-updated', card: F2_upd });

    expect(s.cards.map((c) => c.id)).toContain('card-f2');
    const card = s.cards.find((c) => c.id === 'card-f2');
    expect(card?.title).toBe('Burst Beta v2');
    expect(card?.status).toBe('done');
    expect(s.total).toBe(2);
  });

  // ── Scenario 5: Total consistency across rapid create/delete cycles ──
  it('keeps total consistent through rapid alternating create/delete cycles', () => {
    const s = setupStore();
    s.setupWsListener();

    const X1 = makeCard({ id: 'x-1', title: 'X1' });
    const X2 = makeCard({ id: 'x-2', title: 'X2' });
    const X3 = makeCard({ id: 'x-3', title: 'X3' });

    fireWsEvent('activity', { event: 'card-created', card: X1 });
    fireWsEvent('activity', { event: 'card-created', card: X2 });
    fireWsEvent('activity', { event: 'card-created', card: X3 });
    expect(s.total).toBe(3);
    expect(s.cards).toHaveLength(3);

    fireWsEvent('activity', { event: 'card-deleted', id: 'x-1' });
    expect(s.total).toBe(2);
    fireWsEvent('activity', { event: 'card-deleted', id: 'x-3' });
    expect(s.total).toBe(1);

    const X4 = makeCard({ id: 'x-4', title: 'X4' });
    fireWsEvent('activity', { event: 'card-created', card: X4 });
    expect(s.total).toBe(2);
    expect(s.cards).toHaveLength(2);
    expect(s.cards.map((c) => c.id).sort()).toEqual(['x-2', 'x-4']);
  });

  // ── Scenario 6: Gen guard discards stale fetch even when intermediate mutations occurred ──
  it('discards a background fetch from an earlier mutation when later mutations have happened', async () => {
    const s = setupStore();

    vi.mocked(listCards).mockResolvedValue(mlr([F1]));
    await s.fetchCards();
    expect(s.total).toBe(1);

    s.setupWsListener();

    const deferreds: Array<{
      resolve: (v: CardListResponse) => void;
      reject: (e: Error) => void;
    }> = [];
    let callIdx = 0;
    const mockedListCards = vi.mocked(listCards);
    mockedListCards.mockReset();
    mockedListCards.mockImplementation(() => {
      const idx = callIdx++;
      return new Promise<CardListResponse>((resolve, reject) => {
        deferreds[idx] = { resolve, reject };
      });
    });

    // Event 1: create F2 → gen=1, fetch call#0
    fireWsEvent('activity', { event: 'card-created', card: F2 });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f2', 'card-f1']);
    expect(s.total).toBe(2);

    // Event 2: create F3 → gen=2, fetch call#1
    fireWsEvent('activity', { event: 'card-created', card: F3 });
    expect(s.cards.map((c) => c.id)).toEqual(['card-f3', 'card-f2', 'card-f1']);
    expect(s.total).toBe(3);

    // Resolve call#0 (from create F2, gen=1) — should be DISCARDED because gen is now 2
    deferreds[0].resolve(mlr([F1, F2])); // returns only F1,F2 (missing F3)

    await vi.waitFor(() => {}, { timeout: 500 });

    // The stale fetch must NOT have overwritten the optimistic state
    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f2', 'card-f3']);
    expect(s.total).toBe(3);

    // Resolve call#1 (from create F3, gen=2) — should apply because gen matches
    deferreds[1].resolve(mlr([F1, F2, F3]));

    await vi.waitFor(() => {}, { timeout: 500 });

    expect(s.cards.map((c) => c.id).sort()).toEqual(['card-f1', 'card-f2', 'card-f3']);
    expect(s.total).toBe(3);
  });

  // ── Scenario 7: Many rapid events with interleaved fetch resolutions ──
  it('stays consistent after 10 rapid alternating create/delete events', () => {
    const s = setupStore();
    s.setupWsListener();

    // Create 5 cards, delete 3 of them, create 2 more — all synchronously
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = makeCard({ id: `burst-${i}`, title: `Burst ${i}` });
      fireWsEvent('activity', { event: 'card-created', card: c });
      created.push(c.id);
    }

    // Delete cards 1, 3
    fireWsEvent('activity', { event: 'card-deleted', id: 'burst-1' });
    fireWsEvent('activity', { event: 'card-deleted', id: 'burst-3' });

    // Create 2 more
    for (let i = 5; i < 7; i++) {
      const c = makeCard({ id: `burst-${i}`, title: `Burst ${i}` });
      fireWsEvent('activity', { event: 'card-created', card: c });
    }

    // Expected: 5 created - 2 deleted + 2 created = 5 cards
    expect(s.cards).toHaveLength(5);
    expect(s.total).toBe(5);

    // Verify no duplicates
    const ids = s.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Verify deleted cards are absent
    expect(s.cards.find((c) => c.id === 'burst-1')).toBeUndefined();
    expect(s.cards.find((c) => c.id === 'burst-3')).toBeUndefined();

    // Verify new cards are present
    expect(s.cards.find((c) => c.id === 'burst-5')).toBeDefined();
    expect(s.cards.find((c) => c.id === 'burst-6')).toBeDefined();
  });
});
