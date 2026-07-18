import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { CardRecord, CardListResponse, CardDetailResponse, LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsSyncFrameHandler } from '../api/websocket';

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));

import { getCard, listCards, ApiError } from '../api/client';
import { useCardStore } from '../stores/cards';
import { SyncClient } from '../sync/client';
import { cardView } from './card-view-fixtures';

function setupStore() { setActivePinia(createPinia()); vi.clearAllMocks(); return useCardStore(); }
function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const id = overrides.id ?? 'project';
  const rest = { ...overrides };
  delete rest.id;
  delete rest.parent;
  delete rest.depth;
  return cardView(id, { status: 'running', title: `Card ${id}`, priority: 5, created_by: 'user', ...rest });
}
function mlr(cards: CardRecord[], total?: number): CardListResponse { return { cards, total: total ?? cards.length }; }
function mdr(card: CardRecord, children: CardRecord[] = []): CardDetailResponse { return { card, children }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const A_ID = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_ID = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const A_CHILD_B_ID = `${A_ID}-bbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
const A_CHILD_C_ID = `${A_ID}-cccccccccccccccccccccccccccc`;
const A = makeCard({ id: A_ID, parent: 'project', depth: 1, title: 'Alpha' });
const B = makeCard({ id: B_ID, parent: 'project', depth: 1, title: 'Beta' });

function createSyncHarness() {
  const syncHandlers = new Set<WsSyncFrameHandler>();
  const conn: WsConnectionManager = {
    state: { value: 'offline' as WsConnectionState },
    sessionId: { value: null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconfigure: vi.fn(),
    sendMessage: vi.fn(),
    sendRaw: vi.fn(() => true),
    onEvent: vi.fn(() => () => undefined),
    onSyncFrame: vi.fn((handler) => { syncHandlers.add(handler); return () => syncHandlers.delete(handler); }),
    onOpen: vi.fn(() => () => undefined),
    onState: vi.fn(() => () => undefined),
  };
  return {
    conn,
    emitSync(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame) {
      for (const handler of syncHandlers) handler(frame);
    },
  };
}

describe('useCardStore evidence support', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the newer linked collection authoritative when a Cards invalidation overlaps an old list', async () => {
    const s = setupStore();
    const harness = createSyncHarness();
    const client = new SyncClient(harness.conn);
    const oldList = deferred<CardListResponse>();
    const newList = deferred<CardListResponse>();
    const projectBefore = makeCard({ id: 'project', children: [A_ID] });
    const projectAfter = makeCard({ id: 'project', children: [A_ID] });
    const parentBefore = makeCard({ ...A, children: [] });
    const parentAfter = makeCard({ ...A, children: [A_CHILD_B_ID] });
    const linkedChild = makeCard({ id: A_CHILD_B_ID, parent: A_ID, depth: 2, title: 'New linked child' });
    vi.mocked(listCards)
      .mockReturnValueOnce(oldList.promise)
      .mockReturnValueOnce(newList.promise);
    client.register({ resource: 'cards', scope: 'core', refetch: s.refetch });
    client.start();

    const oldRefetch = s.refetch();
    expect(listCards).toHaveBeenCalledTimes(1);
    expect(s.collectionLoading).toBe(true);

    harness.emitSync({ t: 'invalidate', resource: 'cards' });
    expect(listCards).toHaveBeenCalledTimes(2);

    newList.resolve(mlr([projectAfter, parentAfter, linkedChild], 3));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.cards.map((card) => card.id)).toEqual(['project', A_ID, A_CHILD_B_ID]);
    expect(s.total).toBe(3);
    expect(s.collectionLoading).toBe(false);
    expect(s.collectionRefreshing).toBe(false);
    expect(s.collectionError).toBeNull();
    expect(s.collectionRefreshError).toBeNull();
    expect(s.orderedCardTree[0].card.id).toBe('project');
    expect(s.orderedCardTree[0].childNodes[0].card.id).toBe(A_ID);
    expect(s.orderedCardTree[0].childNodes[0].childNodes[0].card.id).toBe(A_CHILD_B_ID);
    expect(s.cards[1].children).toEqual([A_CHILD_B_ID]);

    oldList.resolve(mlr([projectBefore, parentBefore], 2));
    await expect(oldRefetch).resolves.toBeUndefined();
    expect(s.cards.map((card) => card.id)).toEqual(['project', A_ID, A_CHILD_B_ID]);
    expect(s.total).toBe(3);
    expect(s.collectionLoading).toBe(false);
    expect(s.collectionRefreshing).toBe(false);
    expect(s.collectionError).toBeNull();
    expect(s.collectionRefreshError).toBeNull();
    expect(s.orderedCardTree[0].childNodes[0].childNodes[0].card.id).toBe(A_CHILD_B_ID);
  });

  it('stores backend card detail and derives local lifecycle view state', async () => {
    const s = setupStore();
    const child = makeCard({ id: A_CHILD_B_ID, parent: A.id, depth: 2, status: 'running' });
    const parent = makeCard({ ...A, children: [child.id] });
    vi.mocked(getCard).mockResolvedValue(mdr(parent, [child]));
    await s.fetchCardDetail(A.id);
    expect(s.currentCard?.id).toBe(A.id);
    expect(s.currentChildren.map((card) => card.id)).toEqual([A_CHILD_B_ID]);
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

  it('confines pending and failed detail state to detail while preserving the canonical collection state', async () => {
    const s = setupStore();
    s.cards = [A, B];
    s.collectionLoading = false;
    s.collectionRefreshing = true;
    s.collectionError = 'existing collection error';
    s.collectionRefreshError = 'existing refresh error';
    const canonicalCards = s.cards;
    const canonicalA = s.cards[0];
    const request = deferred<CardDetailResponse>();
    vi.mocked(getCard).mockReturnValue(request.promise);

    const detailPromise = s.fetchCardDetail(A.id);
    expect(s.currentDetailLoading).toBe(true);
    expect(s.currentDetailError).toBeNull();
    expect(s.cards).toBe(canonicalCards);
    expect(s.cards[0]).toBe(canonicalA);
    expect({
      loading: s.collectionLoading,
      refreshing: s.collectionRefreshing,
      error: s.collectionError,
      refreshError: s.collectionRefreshError,
    }).toEqual({
      loading: false,
      refreshing: true,
      error: 'existing collection error',
      refreshError: 'existing refresh error',
    });

    request.reject(new Error('detail unavailable'));
    await expect(detailPromise).rejects.toThrow('detail unavailable');
    expect(s.currentDetailLoading).toBe(false);
    expect(s.currentDetailError).toEqual({ kind: 'network', status: null, message: 'detail unavailable' });
    expect(s.cards).toBe(canonicalCards);
    expect(s.cards[0]).toBe(canonicalA);
    expect(s.collectionLoading).toBe(false);
    expect(s.collectionRefreshing).toBe(true);
    expect(s.collectionError).toBe('existing collection error');
    expect(s.collectionRefreshError).toBe('existing refresh error');
  });

  it.each(['success', 'rejection'] as const)('keeps B authoritative through stale A %s and cleanup', async (staleOutcome) => {
    const s = setupStore();
    const requestA = deferred<CardDetailResponse>();
    const requestB = deferred<CardDetailResponse>();
    vi.mocked(getCard)
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);

    const promiseA = s.fetchCardDetail(A.id);
    const promiseB = s.fetchCardDetail(B.id);
    expect(s.currentDetailLoading).toBe(true);
    expect(s.currentCard).toBeNull();

    if (staleOutcome === 'success') requestA.resolve(mdr(A));
    else requestA.reject(new Error('stale A failed'));
    if (staleOutcome === 'success') await promiseA;
    else await expect(promiseA).resolves.toBeUndefined();

    expect(s.currentDetailLoading).toBe(true);
    expect(s.currentCard).toBeNull();
    expect(s.currentDetailError).toBeNull();

    requestB.resolve(mdr(B));
    await promiseB;
    expect(s.currentDetailLoading).toBe(false);
    expect(s.currentCard?.id).toBe(B.id);
    expect(s.currentDetailError).toBeNull();
  });

  it('lets only B publish its detail error and clear detail loading', async () => {
    const s = setupStore();
    const requestA = deferred<CardDetailResponse>();
    const requestB = deferred<CardDetailResponse>();
    vi.mocked(getCard)
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise);

    const promiseA = s.fetchCardDetail(A.id);
    const promiseB = s.fetchCardDetail(B.id);
    requestA.resolve(mdr(A));
    await promiseA;
    expect(s.currentDetailLoading).toBe(true);
    expect(s.currentCard).toBeNull();

    requestB.reject(new Error('B failed'));
    await expect(promiseB).rejects.toThrow('B failed');
    expect(s.currentDetailLoading).toBe(false);
    expect(s.currentCard).toBeNull();
    expect(s.currentDetailError).toEqual({ kind: 'network', status: null, message: 'B failed' });
  });

  it('reports per-card stale notifications through isStale', () => {
    const s = setupStore();
    s.setCardStaleNotification(A.id, true);
    s.setCardStaleNotification(B_ID, false);
    expect(s.isStale(A.id)).toBe(true);
    expect(s.isStale(B_ID)).toBe(false);
    expect(s.isStale(A_CHILD_C_ID)).toBe(false);
  });
});
