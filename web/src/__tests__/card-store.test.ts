import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardChildrenResponse, CardDetailResponse, CardRecord } from '../api/types';

vi.mock('../api/client', () => ({
  getCardChildren: vi.fn(),
  getCard: vi.fn(),
  listCardHistory: vi.fn(),
  getCardHistoryEntry: vi.fn(),
  getCardDiff: vi.fn(),
  getFileContent: vi.fn(),
  ApiError: class extends Error { body = {}; constructor(public status: number, text: string) { super(text); } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));

import { ApiError, getCard, getCardChildren, getCardDiff, getFileContent } from '../api/client';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

const A = 'card-a';
const AB = 'card-a-b';
const AC = 'card-a-c';
const B = 'card-b';
const card = (id: string, overrides: Partial<CardRecord> = {}) => cardView(id, overrides);
const childrenResponse = (parent: CardRecord, children: CardRecord[]): CardChildrenResponse => ({ card: parent, children });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('lazy CardStore', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it('loads root and expansions once and derives paths from committed slice order', async () => {
    vi.mocked(getCardChildren)
      .mockResolvedValueOnce(childrenResponse(card('project', { children: [B, A] }), [card(B, { title: 'B' }), card(A, { title: 'A', children: [AC, AB] })]))
      .mockResolvedValueOnce(childrenResponse(card(A, { children: [AC, AB] }), [card(AC), card(AB)]));
    const store = useCardStore();
    await store.ensureRoot();
    await store.ensureChildren(A);
    await store.ensureChildren(A);
    expect(vi.mocked(getCardChildren).mock.calls.map(([id]) => id)).toEqual(['project', A]);
    expect(store.hierarchyPathFor(B)).toBe('1');
    expect(store.hierarchyPathFor(A)).toBe('2');
    expect(store.hierarchyPathFor(AC)).toBe('2.1');
    expect(store.hierarchyPathFor(AB)).toBe('2.2');
  });

  it('exposes only settled node-local errors for explicit retry', async () => {
    vi.mocked(getCardChildren)
      .mockRejectedValueOnce(new Error('branch failed'))
      .mockResolvedValueOnce(childrenResponse(card(A), []));
    const store = useCardStore();
    await expect(store.ensureChildren(A)).rejects.toThrow('branch failed');
    expect(store.childrenLoadState(A)).toMatchObject({ status: 'error', error: 'branch failed', stale: false });
    await store.ensureChildren(A);
    expect(getCardChildren).toHaveBeenCalledTimes(1);
    await store.retryChildren(A);
    expect(getCardChildren).toHaveBeenCalledTimes(2);
    expect(store.childrenLoadState(A)).toMatchObject({ status: 'loaded', error: null, stale: false });
    expect(() => store.retryChildren(A)).toThrow("Children for 'card-a' are not retryable.");
  });

  it('shares the exact same-parent owner promise and isolates different parents', async () => {
    const root = deferred<CardChildrenResponse>();
    const branch = deferred<CardChildrenResponse>();
    vi.mocked(getCardChildren).mockImplementation((id) => id === 'project' ? root.promise : branch.promise);
    const store = useCardStore();
    const first = store.ensureChildren('project');
    const owner = store.childrenRequestOwnersByParentId.get('project')!;
    const second = store.ensureChildren('project');
    const other = store.ensureChildren(A);
    expect(first).toBe(owner.promise);
    expect(second).toBe(owner.promise);
    expect(store.childrenRequestOwnersByParentId.get('project')).toBe(owner);
    expect(owner.promise).toBe(store.childrenRequestOwnersByParentId.get('project')!.promise);
    expect(getCardChildren).toHaveBeenCalledTimes(0);
    expect(other).not.toBe(first);
    root.resolve(childrenResponse(card('project'), []));
    branch.resolve(childrenResponse(card(A), []));
    await Promise.all([first, second, other]);
  });

  it.each(['success', 'rejection'] as const)('excludes old %s and finalizer after reset and a new same-parent owner', async (outcome) => {
    const oldRequest = deferred<CardChildrenResponse>();
    const nextRequest = deferred<CardChildrenResponse>();
    vi.mocked(getCardChildren).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(nextRequest.promise);
    const store = useCardStore();
    const oldPromise = store.ensureRoot();
    const oldOwner = store.childrenRequestOwnersByParentId.get('project')!;
    store.reset();
    expect(oldOwner.controller.signal.aborted).toBe(true);
    expect(store.childrenRequestOwnersByParentId.get('project')).toBeUndefined();
    const nextPromise = store.ensureRoot();
    const nextOwner = store.childrenRequestOwnersByParentId.get('project')!;
    expect(nextOwner).not.toBe(oldOwner);
    if (outcome === 'success') oldRequest.resolve(childrenResponse(card('project', { title: 'old' }), []));
    else oldRequest.reject(new Error('old failure'));
    if (outcome === 'success') await oldPromise; else await expect(oldPromise).resolves.toBeUndefined();
    expect(store.childrenRequestOwnersByParentId.get('project')).toBe(nextOwner);
    expect(store.childrenLoadState('project').status).toBe('loading');
    expect(store.hierarchySlicesByParentId.project).toBeUndefined();
    nextRequest.resolve(childrenResponse(card('project', { title: 'new' }), []));
    await nextPromise;
    expect(store.hierarchySlicesByParentId.project.parent.title).toBe('new');
  });

  it('keeps hierarchy and selected detail disjoint in both completion orders', async () => {
    for (const order of ['detail-first', 'children-first'] as const) {
      setActivePinia(createPinia());
      const detail = deferred<CardDetailResponse>();
      const hierarchy = deferred<CardChildrenResponse>();
      vi.mocked(getCard).mockReturnValueOnce(detail.promise);
      vi.mocked(getCardChildren).mockReturnValueOnce(hierarchy.promise);
      const store = useCardStore();
      const detailPromise = store.fetchCardDetail('project');
      const hierarchyPromise = store.ensureRoot();
      const resolveDetail = () => detail.resolve({ card: card('project', { title: 'detail title' }) });
      const resolveHierarchy = () => hierarchy.resolve(childrenResponse(card('project', { title: 'tree title' }), [card(A)]));
      if (order === 'detail-first') { resolveDetail(); await detailPromise; resolveHierarchy(); await hierarchyPromise; }
      else { resolveHierarchy(); await hierarchyPromise; resolveDetail(); await detailPromise; }
      expect(store.selectedDetail?.card.title).toBe('detail title');
      expect(store.orderedCardTree[0]?.card.title).toBe('tree title');
    }
  });

  it('supersedes route reveal without cancelling shared work or issuing the obsolete next request', async () => {
    const root = deferred<CardChildrenResponse>();
    vi.mocked(getCardChildren).mockImplementation(async (id) => {
      if (id === 'project') return root.promise;
      if (id === B) return childrenResponse(card(B, { children: [] }), []);
      throw new Error(`unexpected ${id}`);
    });
    const store = useCardStore();
    const revealA = store.ensureRouteVisible(AB);
    await flush();
    const owner = store.childrenRequestOwnersByParentId.get('project')!;
    const revealB = store.ensureRouteVisible(B);
    root.resolve(childrenResponse(card('project', { children: [A, B] }), [card(A, { children: [AB] }), card(B)]));
    await Promise.all([revealA, revealB]);
    expect(owner.controller.signal.aborted).toBe(false);
    expect(vi.mocked(getCardChildren).mock.calls.map(([id]) => id)).toEqual(['project']);
    expect(store.childrenLoadState('project').status).toBe('loaded');
  });

  it('checks supersession again after a later ancestor await', async () => {
    const branch = deferred<CardChildrenResponse>();
    vi.mocked(getCardChildren).mockImplementation(async (id) => {
      if (id === 'project') return childrenResponse(card('project', { children: [A, B] }), [card(A, { children: [AB] }), card(B)]);
      if (id === A) return branch.promise;
      throw new Error(`unexpected ${id}`);
    });
    const store = useCardStore();
    await store.ensureRoot();
    const oldReveal = store.ensureRouteVisible('card-a-b-c');
    await flush();
    await store.ensureRouteVisible(B);
    branch.resolve(childrenResponse(card(A, { children: [AB] }), [card(AB, { children: ['card-a-b-c'] })]));
    await oldReveal;
    expect(vi.mocked(getCardChildren).mock.calls.map(([id]) => id)).toEqual(['project', A]);
    expect(store.childrenLoadState(A).status).toBe('loaded');
    expect(store.childrenLoadState(AB).status).toBe('idle');
  });

  it('stops on a retained loaded slice that omits the route edge', async () => {
    vi.mocked(getCardChildren).mockResolvedValue(childrenResponse(card('project', { children: [B] }), [card(B)]));
    const store = useCardStore();
    await store.ensureRoot();
    await store.ensureRouteVisible(AB);
    expect(getCardChildren).toHaveBeenCalledTimes(1);
    expect(store.hierarchySlicesByParentId.project.children.map((entry) => entry.id)).toEqual([B]);
  });

  it('implements the state-dependent record 404 table and exact Retry', async () => {
    vi.mocked(getFileContent)
      .mockRejectedValueOnce(new ApiError(404, 'required absent', {}))
      .mockRejectedValueOnce(new ApiError(404, 'optional absent', {}))
      .mockRejectedValueOnce(new ApiError(404, 'optional absent', {}));
    const store = useCardStore();
    await store.loadCardRecords(A);
    expect(store.cardRecords.brief).toMatchObject({ accepted: null, error: 'required absent', stale: false });
    expect(store.cardRecords.status.accepted).toEqual({ kind: 'empty' });
    expect(store.cardRecords.review.accepted).toEqual({ kind: 'empty' });

    vi.mocked(getFileContent).mockResolvedValueOnce({ path: '', size: 1, contentType: 'text/markdown', content: 'closed status', redacted: false, sensitivity: 'normal', version: 2, modifiedAt: 'now' });
    await store.refreshRecord('status', 'invalidated');
    vi.mocked(getFileContent).mockRejectedValueOnce(new ApiError(404, 'opaque card', {}));
    await store.refreshRecord('status', 'invalidated');
    expect(store.cardRecords.status).toMatchObject({ accepted: { kind: 'content', content: 'closed status' }, stale: true, staleReason: 'refresh-failed', refreshError: 'opaque card' });
    vi.mocked(getFileContent).mockResolvedValueOnce({ path: '', size: 1, contentType: 'text/markdown', content: 'replacement', redacted: false, sensitivity: 'normal', version: 3, modifiedAt: 'later' });
    await store.retryRecord('status');
    expect(store.cardRecords.status).toMatchObject({ accepted: { kind: 'content', content: 'replacement' }, stale: false });

    vi.mocked(getFileContent).mockRejectedValueOnce(new ApiError(404, 'still absent', {}));
    await store.refreshRecord('review', 'reconnect');
    expect(store.cardRecords.review).toMatchObject({ accepted: { kind: 'empty' }, stale: false, refreshError: null });
  });

  it('excludes an old selected-card record completion even when it resolves after abort', async () => {
    const oldBrief = deferred<any>();
    vi.mocked(getFileContent).mockImplementation((path) => path.includes('brief') && path.includes(A) ? oldBrief.promise : Promise.reject(new ApiError(404, 'absent', {})));
    const store = useCardStore();
    const oldLoad = store.loadCardRecords(A);
    await flush();
    await store.loadCardRecords(B);
    oldBrief.resolve({ path: '', size: 1, contentType: 'text/markdown', content: 'old card content', redacted: false, sensitivity: 'normal', version: 1, modifiedAt: 'now' });
    await oldLoad;
    expect(store.selectedCardId).toBe(B);
    expect(store.cardRecords.brief.accepted).toBeNull();
  });

  it('keeps a literal current-relative diff key independent of selected detail version', async () => {
    vi.mocked(getCardDiff).mockResolvedValue({ card_id: A, from: 2, to: 9, diff: [{ field: 'title', before: 'old', after: 'new' }] });
    const { getCardHistoryEntry } = await import('../api/client');
    vi.mocked(getCardHistoryEntry).mockResolvedValue({ entry: { card_id: A, version_seq: 2 } as any });
    const store = useCardStore();
    store.selectedCardId = A;
    store.cardHistoryVisible = true;
    await store.selectCardHistoryVersion(A, 2);
    expect(getCardDiff).toHaveBeenCalledWith({ cardId: A, fromSeq: 2, to: 'current' }, expect.any(AbortSignal));
    expect(store.cardHistoryDiffKey).toEqual({ cardId: A, fromSeq: 2, to: 'current' });
    expect(store.cardHistoryDiff[0]?.after).toBe('new');
  });

  it('reconnect snapshots accepted scopes once and excludes failed-stale scopes', async () => {
    vi.mocked(getCardChildren)
      .mockResolvedValueOnce(childrenResponse(card('project'), []))
      .mockRejectedValueOnce(new Error('root refresh failed'));
    const store = useCardStore();
    await store.ensureRoot();
    await store.refreshChildren('project', 'invalidated');
    expect(store.childrenLoadState('project')).toMatchObject({ stale: true, staleReason: 'refresh-failed' });
    const calls = vi.mocked(getCardChildren).mock.calls.length;
    store.onReconnect();
    await flush();
    expect(getCardChildren).toHaveBeenCalledTimes(calls);
    store.onInvalidate({ resource: 'cards', scope: 'children', card_id: A });
    await flush();
    expect(getCardChildren).toHaveBeenCalledTimes(calls);
  });
});
