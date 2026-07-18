import { computed, markRaw, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type {
  CardDiffRow,
  CardHistoryEntry,
  CardHistoryHeader,
  CardRecord,
  CardStatus,
  DetailErrorState,
} from '../api/types';
import {
  ApiError,
  getCard,
  getCardChildren,
  getCardDiff,
  getCardHistoryEntry,
  listCardHistory,
} from '../api/client';

export type ChildrenLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
export interface ChildrenLoadState { status: ChildrenLoadStatus; error: string | null }
export interface HierarchySlice { readonly parent: CardRecord; readonly children: readonly CardRecord[] }
export interface ChildrenRequestOwner { readonly controller: AbortController; promise: Promise<void> }
export interface SelectedCardDetail { readonly cardId: string; readonly card: CardRecord }
export interface CardTreeNode {
  readonly card: CardRecord;
  readonly logicalPath: string | null;
  readonly childNodes: readonly CardTreeNode[];
}

export function buildDetailError(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof ApiError) {
    if (err.isUnauthorized) return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    if (err.isNotFound) return { kind: 'not-found', status: err.status, message: err.message || 'Card not found.' };
    if (err.status >= 500) return { kind: 'server', status: err.status, message: err.message || fallback };
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) return { kind: 'network', status: null, message: err.message || fallback };
  return { kind: 'unknown', status: null, message: fallback };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message || fallback : fallback;
}

export interface CardLifecycleSummary {
  status: CardStatus;
  terminal: boolean;
  phase: 'planned' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  explanation: string;
  completionState: 'not-started' | 'in-progress' | 'blocked' | 'failed' | 'cancelled' | 'marked-done';
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  childCounts?: Record<CardStatus, number>;
  hasActiveChildren?: boolean;
  hasBlockingChildren?: boolean;
  dependencyIds: string[];
  blockedByDependencyIds: string[];
}

const terminalStatuses = new Set<CardStatus>(['done', 'failed', 'cancelled']);
function lifecyclePhase(status: CardStatus): CardLifecycleSummary['phase'] {
  switch (status) {
    case 'backlog': return 'planned';
    case 'running': return 'running';
    case 'blocked': return 'blocked';
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'ready';
  }
}
function completionState(status: CardStatus): CardLifecycleSummary['completionState'] {
  switch (status) {
    case 'backlog': return 'not-started';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'done': return 'marked-done';
    default: return 'in-progress';
  }
}

export function deriveCardLifecycleSummary(card: CardRecord, loadedChildren?: readonly CardRecord[]): CardLifecycleSummary {
  const childProjection = loadedChildren === undefined ? {} : (() => {
    const childCounts = { backlog: 0, running: 0, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0 } satisfies Record<CardStatus, number>;
    for (const child of loadedChildren) childCounts[child.status] += 1;
    return {
      childCounts,
      hasActiveChildren: loadedChildren.some((child) => child.status === 'running'),
      hasBlockingChildren: loadedChildren.some((child) => child.status === 'blocked' || child.status === 'failed'),
    };
  })();
  return {
    status: card.status,
    terminal: terminalStatuses.has(card.status),
    phase: lifecyclePhase(card.status),
    explanation: '',
    completionState: completionState(card.status),
    error: card.lifecycle.error ?? null,
    startedAt: card.started_at ?? null,
    completedAt: card.lifecycle.completed_at ?? null,
    durationMs: null,
    ...childProjection,
    dependencyIds: card.depends_on,
    blockedByDependencyIds: [],
  };
}

function routeIds(cardId: string): string[] {
  if (cardId === 'project') return ['project'];
  const segments = cardId.startsWith('card-') ? cardId.slice(5).split('-') : [];
  if (segments.length === 0 || segments.length > 5 || segments.some((segment) => !/^[a-z]+$/.test(segment))) return [];
  return ['project', ...segments.map((_segment, index) => `card-${segments.slice(0, index + 1).join('-')}`)];
}

// Pinia chains native Promise action results for action hooks. A non-native
// Promise implementation preserves the exact shared owner object at callers.
function stableActionPromise(promise: Promise<void>): Promise<void> {
  return Object.freeze({
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: 'Promise',
  }) as Promise<void>;
}

export const useCardStore = defineStore('cards', () => {
  let latestRouteRevealRequestSeq = 0;
  let detailRequestSeq = 0;
  let detailRequestController: AbortController | null = null;
  let historyRequestSeq = 0;
  let historyEntryRequestSeq = 0;
  let historyRequestController: AbortController | null = null;
  let historyEntryRequestController: AbortController | null = null;

  const hierarchySlicesByParentId = shallowRef<Record<string, HierarchySlice>>({});
  const childrenLoadStateById = shallowRef<Record<string, ChildrenLoadState>>({});
  const childrenRequestOwnersByParentId = markRaw(new Map<string, ChildrenRequestOwner>());
  const selectedDetail = ref<SelectedCardDetail | null>(null);
  const selectedDetailLoading = ref(false);
  const selectedDetailError = ref<DetailErrorState | null>(null);

  const cardHistory = ref<CardHistoryHeader[]>([]);
  const cardHistoryLoading = ref(false);
  const cardHistoryError = ref<DetailErrorState | null>(null);
  const cardHistorySelectedSeq = ref<number | null>(null);
  const cardHistoryEntry = ref<CardHistoryEntry | null>(null);
  const cardHistoryEntryLoading = ref(false);
  const cardHistoryEntryError = ref<DetailErrorState | null>(null);
  const cardHistoryDiff = ref<CardDiffRow[]>([]);
  const cardHistoryDiffLoading = ref(false);
  const cardHistoryDiffError = ref<DetailErrorState | null>(null);

  function childrenLoadState(id: string): ChildrenLoadState {
    return childrenLoadStateById.value[id] ?? { status: 'idle', error: null };
  }
  function loadedChildrenFor(id: string): readonly CardRecord[] | undefined {
    return hierarchySlicesByParentId.value[id]?.children;
  }
  function hierarchyCardById(id: string): CardRecord | null {
    const root = hierarchySlicesByParentId.value.project?.parent;
    if (id === 'project') return root ?? null;
    for (const slice of Object.values(hierarchySlicesByParentId.value)) {
      const card = slice.children.find((child) => child.id === id);
      if (card) return card;
    }
    return null;
  }

  const orderedCardTree = computed<readonly CardTreeNode[]>(() => {
    const root = hierarchySlicesByParentId.value.project?.parent;
    if (!root) return [];
    const build = (card: CardRecord, logicalPath: string | null): CardTreeNode => {
      const slice = hierarchySlicesByParentId.value[card.id];
      const childNodes = slice
        ? slice.children.map((child, index) => build(child, logicalPath === null ? String(index + 1) : `${logicalPath}.${index + 1}`))
        : [];
      return Object.freeze({ card, logicalPath, childNodes: Object.freeze(childNodes) });
    };
    return [build(root, null)];
  });

  function hierarchyPathFor(id: string): string | null {
    const visit = (nodes: readonly CardTreeNode[]): string | null => {
      for (const node of nodes) {
        if (node.card.id === id) return node.logicalPath;
        const found = visit(node.childNodes);
        if (found !== null) return found;
      }
      return null;
    };
    return id === 'project' && orderedCardTree.value.length > 0 ? '' : visit(orderedCardTree.value);
  }
  function isHierarchyCardRepresented(id: string): boolean {
    return id === 'project' ? orderedCardTree.value.length > 0 : hierarchyPathFor(id) !== null;
  }

  function ensureChildren(id: string): Promise<void> {
    const existingOwner = childrenRequestOwnersByParentId.get(id);
    if (existingOwner) return existingOwner.promise;
    const state = childrenLoadState(id);
    if (state.status === 'loaded' || state.status === 'error') return Promise.resolve();

    let resolveOwner!: () => void;
    let rejectOwner!: (error: unknown) => void;
    const nativeOwnerPromise = new Promise<void>((resolve, reject) => { resolveOwner = resolve; rejectOwner = reject; });
    const ownerPromise = stableActionPromise(nativeOwnerPromise);
    const owner = markRaw<ChildrenRequestOwner>({ controller: new AbortController(), promise: ownerPromise });
    childrenRequestOwnersByParentId.set(id, owner);
    childrenLoadStateById.value = { ...childrenLoadStateById.value, [id]: { status: 'loading', error: null } };
    void Promise.resolve().then(() => getCardChildren(id, owner.controller.signal)).then((response) => {
      if (childrenRequestOwnersByParentId.get(id) !== owner) { resolveOwner(); return; }
      if (response.card.id !== id) throw new Error(`Hierarchy response parent '${response.card.id}' does not match '${id}'.`);
      const slice = Object.freeze({ parent: response.card, children: Object.freeze([...response.children]) });
      hierarchySlicesByParentId.value = { ...hierarchySlicesByParentId.value, [id]: slice };
      childrenLoadStateById.value = { ...childrenLoadStateById.value, [id]: { status: 'loaded', error: null } };
      resolveOwner();
    }).catch((error: unknown) => {
      if (childrenRequestOwnersByParentId.get(id) !== owner) { resolveOwner(); return; }
      if (error instanceof DOMException && error.name === 'AbortError') { resolveOwner(); return; }
      childrenLoadStateById.value = { ...childrenLoadStateById.value, [id]: { status: 'error', error: errorMessage(error, 'Failed to load card children') } };
      rejectOwner(error);
    }).finally(() => {
      if (childrenRequestOwnersByParentId.get(id) !== owner) return;
      childrenRequestOwnersByParentId.delete(id);
    });
    return owner.promise;
  }

  function ensureRoot(): Promise<void> { return ensureChildren('project'); }
  function retryChildren(id: string): Promise<void> {
    if (childrenLoadState(id).status !== 'error') throw new Error(`Children for '${id}' are not in error state.`);
    const next = { ...childrenLoadStateById.value };
    delete next[id];
    childrenLoadStateById.value = next;
    return ensureChildren(id);
  }

  async function ensureRouteVisible(selectedId: string): Promise<void> {
    const requestSeq = ++latestRouteRevealRequestSeq;
    const chain = routeIds(selectedId);
    if (chain.length === 0) return;
    for (let index = 0; index < chain.length - 1; index += 1) {
      if (requestSeq !== latestRouteRevealRequestSeq) return;
      const parentId = chain[index]!;
      const state = childrenLoadState(parentId);
      if (state.status === 'error') return;
      if (state.status === 'idle' || state.status === 'loading') {
        try { await ensureChildren(parentId); } catch { return; }
        if (requestSeq !== latestRouteRevealRequestSeq) return;
      }
      const slice = hierarchySlicesByParentId.value[parentId];
      if (!slice || !slice.children.some((child) => child.id === chain[index + 1])) return;
      if (requestSeq !== latestRouteRevealRequestSeq) return;
    }
  }

  function clearCardHistoryState(): void {
    historyRequestController?.abort();
    historyEntryRequestController?.abort();
    historyRequestController = null;
    historyEntryRequestController = null;
    ++historyRequestSeq;
    ++historyEntryRequestSeq;
    cardHistory.value = [];
    cardHistoryLoading.value = false;
    cardHistoryError.value = null;
    cardHistorySelectedSeq.value = null;
    cardHistoryEntry.value = null;
    cardHistoryEntryLoading.value = false;
    cardHistoryEntryError.value = null;
    cardHistoryDiff.value = [];
    cardHistoryDiffLoading.value = false;
    cardHistoryDiffError.value = null;
  }

  async function fetchCardDetail(id: string): Promise<void> {
    const requestSeq = ++detailRequestSeq;
    detailRequestController?.abort();
    const controller = new AbortController();
    detailRequestController = controller;
    if (selectedDetail.value?.cardId !== id) {
      selectedDetail.value = null;
      clearCardHistoryState();
    }
    selectedDetailLoading.value = true;
    selectedDetailError.value = null;
    try {
      const response = await getCard(id, controller.signal);
      if (requestSeq !== detailRequestSeq) return;
      selectedDetail.value = Object.freeze({ cardId: id, card: response.card });
    } catch (error) {
      if (requestSeq !== detailRequestSeq || (error instanceof DOMException && error.name === 'AbortError')) return;
      selectedDetail.value = null;
      selectedDetailError.value = buildDetailError(error, 'Failed to fetch card detail');
      throw error;
    } finally {
      if (requestSeq === detailRequestSeq) selectedDetailLoading.value = false;
    }
  }

  async function fetchCardHistoryForCard(cardId: string): Promise<void> {
    const requestSeq = ++historyRequestSeq;
    historyRequestController?.abort();
    const controller = new AbortController();
    historyRequestController = controller;
    cardHistoryLoading.value = true;
    cardHistoryError.value = null;
    try {
      const response = await listCardHistory(cardId, controller.signal);
      if (requestSeq !== historyRequestSeq || selectedDetail.value?.cardId !== cardId) return;
      cardHistory.value = response.history;
    } catch (error) {
      if (requestSeq !== historyRequestSeq || (error instanceof DOMException && error.name === 'AbortError')) return;
      cardHistoryError.value = buildDetailError(error, 'Failed to load card history');
    } finally {
      if (requestSeq === historyRequestSeq) cardHistoryLoading.value = false;
    }
  }

  async function selectCardHistoryVersion(cardId: string, seq: number): Promise<void> {
    const requestSeq = ++historyEntryRequestSeq;
    historyEntryRequestController?.abort();
    const controller = new AbortController();
    historyEntryRequestController = controller;
    const versionSeq = selectedDetail.value?.cardId === cardId ? selectedDetail.value.card.version_seq : seq + 1;
    cardHistorySelectedSeq.value = seq;
    cardHistoryEntryLoading.value = true;
    cardHistoryDiffLoading.value = true;
    cardHistoryEntryError.value = null;
    cardHistoryDiffError.value = null;
    try {
      const [entryResponse, diffResponse] = await Promise.all([
        getCardHistoryEntry(cardId, seq, controller.signal),
        getCardDiff(cardId, seq, versionSeq, controller.signal),
      ]);
      if (requestSeq !== historyEntryRequestSeq || selectedDetail.value?.cardId !== cardId || cardHistorySelectedSeq.value !== seq) return;
      cardHistoryEntry.value = entryResponse.entry;
      cardHistoryDiff.value = diffResponse.diff;
    } catch (error) {
      if (requestSeq !== historyEntryRequestSeq || (error instanceof DOMException && error.name === 'AbortError')) return;
      const panelError = buildDetailError(error, 'Failed to load card history details');
      cardHistoryEntryError.value = panelError;
      cardHistoryDiffError.value = panelError;
    } finally {
      if (requestSeq === historyEntryRequestSeq) {
        cardHistoryEntryLoading.value = false;
        cardHistoryDiffLoading.value = false;
      }
    }
  }

  function reset(): void {
    ++latestRouteRevealRequestSeq;
    for (const owner of childrenRequestOwnersByParentId.values()) owner.controller.abort();
    childrenRequestOwnersByParentId.clear();
    hierarchySlicesByParentId.value = {};
    childrenLoadStateById.value = {};
    detailRequestController?.abort();
    detailRequestController = null;
    ++detailRequestSeq;
    selectedDetail.value = null;
    selectedDetailLoading.value = false;
    selectedDetailError.value = null;
    clearCardHistoryState();
  }

  const selectedLifecycle = computed(() => selectedDetail.value
    ? deriveCardLifecycleSummary(selectedDetail.value.card, loadedChildrenFor(selectedDetail.value.cardId))
    : null);

  return {
    hierarchySlicesByParentId,
    childrenLoadStateById,
    childrenRequestOwnersByParentId,
    selectedDetail,
    selectedDetailLoading,
    selectedDetailError,
    selectedLifecycle,
    orderedCardTree,
    cardHistory,
    cardHistoryLoading,
    cardHistoryError,
    cardHistorySelectedSeq,
    cardHistoryEntry,
    cardHistoryEntryLoading,
    cardHistoryEntryError,
    cardHistoryDiff,
    cardHistoryDiffLoading,
    cardHistoryDiffError,
    childrenLoadState,
    loadedChildrenFor,
    hierarchyCardById,
    hierarchyPathFor,
    isHierarchyCardRepresented,
    ensureChildren,
    ensureRoot,
    retryChildren,
    ensureRouteVisible,
    fetchCardDetail,
    fetchCardHistoryForCard,
    selectCardHistoryVersion,
    clearCardHistoryState,
    reset,
  };
});
