import { computed, markRaw, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { CardDetail, CardDiffRow, CardHierarchyRecord, CardHistoryEntry, CardHistoryHeader, CardRecordContentResponse, CardRecordDescriptor, DetailErrorState, LiveSyncCardInvalidateTarget, LiveSyncCardRecordName, RecordDiffResponse, RecordHistoryListResponse, RecordVersionContentResponse } from '../api/types';
import { OperatorApiError, getCard, getCardChildren, getCardDiff, getCardHistoryEntry, getCardRecord, getRecordDiff, getRecordVersion, isOperatorApiError, listCardHistory, listCardRecords, listRecordHistory, type CurrentCardDiffKey } from '../api/client';
import { abortRequestOwner, abortRequestOwners, releaseRequestOwner, replaceRequestOwner, withKey } from './keyed-containers';
import { cardIdSchema, cardIdSegments } from '@saivage/schemas';

export type ChildrenLoadStatus = 'undiscovered' | 'loading' | 'error' | 'loaded-nonempty' | 'confirmed-leaf';
export type StaleReason = 'invalidated' | 'reconnect' | 'refresh-failed';
export interface FreshnessState { refreshing: boolean; stale: boolean; staleReason: StaleReason | null; refreshError: string | null }
export interface ChildrenLoadState extends FreshnessState { status: ChildrenLoadStatus; error: string | null }
export interface HierarchySlice { readonly parent: CardHierarchyRecord; readonly children: readonly CardHierarchyRecord[] }
export interface RequestOwner { readonly controller: AbortController; promise: Promise<void> }
export type ChildrenRequestOwner = RequestOwner;
export interface SelectedCardDetail { readonly cardId: string; readonly card: CardDetail }
export type RecordAccepted = { kind: 'content'; version: number; committedAt: string; content: string } | { kind: 'empty' };
export interface RecordSlotState extends FreshnessState { name: LiveSyncCardRecordName; descriptor:CardRecordDescriptor; loading: boolean; error: string | null; current: CardRecordContentResponse | null; accepted: RecordAccepted | null; history: RecordHistoryListResponse | null; historyLoading:boolean; historyError: string | null; selectedVersion:number|null; selected: RecordVersionContentResponse | null; selectedLoading:boolean; selectedError: string | null; diff: RecordDiffResponse | null; diffLoading:boolean; diffError: string | null }
export interface CardTreeNode { readonly card: CardHierarchyRecord; readonly logicalPath: string | null; readonly childNodes: readonly CardTreeNode[] }

const fresh = (): FreshnessState => ({ refreshing: false, stale: false, staleReason: null, refreshError: null });
const undiscoveredChildren = (): ChildrenLoadState => ({ status: 'undiscovered', error: null, ...fresh() });
const emptyRecordState = (descriptor:CardRecordDescriptor): RecordSlotState => ({ name:descriptor.name,descriptor, loading: false, error: null, current:null,accepted: null, history:null,historyLoading:false,historyError:null,selectedVersion:null,selected:null,selectedLoading:false,selectedError:null,diff:null,diffLoading:false,diffError:null,...fresh() });
const emptyRecords = (): Record<string, RecordSlotState> => ({});
const recordsFrom=(descriptors:readonly CardRecordDescriptor[]):Record<string,RecordSlotState>=>Object.fromEntries(descriptors.map((descriptor)=>[descriptor.name,emptyRecordState(descriptor)]));
function sameDescriptor(left:CardRecordDescriptor,right:CardRecordDescriptor):boolean{return left.name===right.name&&left.format===right.format&&left.schema===right.schema&&left.bootstrap===right.bootstrap&&left.writers.length===right.writers.length&&left.writers.every((writer,index)=>writer===right.writers[index]);}

export function buildDetailError(err: unknown, fallback: string): DetailErrorState {
  if (err instanceof OperatorApiError) {
    if (err.isUnauthorized) return { kind: 'unauthorized', status: err.status, message: err.message || 'Unauthorized.' };
    if (err.isNotFound) return { kind: 'not-found', status: err.status, message: err.message || 'Card not found.' };
    if (err.status >= 500) return { kind: 'server', status: err.status, message: err.message || fallback };
    return { kind: 'unknown', status: err.status, message: err.message || fallback };
  }
  if (err instanceof Error) return { kind: 'network', status: null, message: err.message || fallback };
  return { kind: 'unknown', status: null, message: fallback };
}
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message || fallback : fallback;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export function cardRouteChain(cardId: string): string[] {
  if (!cardIdSchema.safeParse(cardId).success) return [];
  if (cardId === 'project') return ['project'];
  const parts = cardIdSegments(cardId);
  return ['project', ...parts.map((_part, index) => `card-${parts.slice(0, index + 1).join('-')}`)];
}
export function routeAncestorParentIds(cardId: string): readonly string[] { return cardRouteChain(cardId).slice(0, -1); }
function stableActionPromise(promise: Promise<void>): Promise<void> { return Object.freeze({ then: promise.then.bind(promise), catch: promise.catch.bind(promise), finally: promise.finally.bind(promise), [Symbol.toStringTag]: 'Promise' }) as Promise<void>; }

export const useCardStore = defineStore('cards', () => {
  let revealSeq = 0;
  const hierarchySlicesByParentId = shallowRef<Record<string, HierarchySlice>>({});
  const childrenLoadStateById = shallowRef<Record<string, ChildrenLoadState>>({});
  const childrenRequestOwnersByParentId = markRaw(new Map<string, RequestOwner>());
  const selectedCardId = ref<string | null>(null);
  const selectedDetail = ref<SelectedCardDetail | null>(null);
  const selectedDetailLoading = ref(false);
  const selectedDetailError = ref<DetailErrorState | null>(null);
  const selectedDetailFreshness = ref<FreshnessState>(fresh());
  let detailOwner: RequestOwner | null = null;

  const cardRecords = ref(emptyRecords());
  const recordDescriptors = ref<readonly CardRecordDescriptor[]>([]);
  const recordDescriptorsLoading = ref(false);
  const recordDescriptorsError = ref<string | null>(null);
  let descriptorOwner: RequestOwner | null = null;
  const recordOwners = markRaw(new Map<LiveSyncCardRecordName, RequestOwner>());
  const recordHistoryOwners = markRaw(new Map<LiveSyncCardRecordName, RequestOwner>());
  const recordVersionOwners = markRaw(new Map<LiveSyncCardRecordName, RequestOwner>());
  const recordDiffOwners = markRaw(new Map<LiveSyncCardRecordName, RequestOwner>());
  const cardHistory = ref<CardHistoryHeader[]>([]);
  const cardHistoryLoading = ref(false);
  const cardHistoryError = ref<DetailErrorState | null>(null);
  const cardHistoryFreshness = ref<FreshnessState>(fresh());
  const cardHistoryVisible = ref(false);
  const cardHistoryAccepted = ref(false);
  let historyOwner: RequestOwner | null = null;
  const cardHistorySelectedVersion = ref<number | null>(null);
  const cardHistoryEntry = ref<CardHistoryEntry | null>(null);
  const cardHistoryEntryLoading = ref(false);
  const cardHistoryEntryError = ref<DetailErrorState | null>(null);
  let entryOwner: RequestOwner | null = null;
  const cardHistoryDiff = ref<CardDiffRow[]>([]);
  const cardHistoryDiffKey = ref<CurrentCardDiffKey | null>(null);
  const cardHistoryDiffLoading = ref(false);
  const cardHistoryDiffError = ref<DetailErrorState | null>(null);
  const cardHistoryDiffFreshness = ref<FreshnessState>(fresh());
  let diffOwner: RequestOwner | null = null;

  function childrenLoadState(id: string): ChildrenLoadState { return childrenLoadStateById.value[id] ?? undiscoveredChildren(); }
  function setChildrenState(id: string, state: ChildrenLoadState): void { childrenLoadStateById.value = { ...childrenLoadStateById.value, [id]: state }; }
  function loadedChildrenFor(id: string): readonly CardHierarchyRecord[] | undefined { return hierarchySlicesByParentId.value[id]?.children; }
  function hierarchyCardById(id: string): CardHierarchyRecord | null { if (id === 'project') return hierarchySlicesByParentId.value.project?.parent ?? null; for (const slice of Object.values(hierarchySlicesByParentId.value)) { const found = slice.children.find((child) => child.id === id); if (found) return found; } return null; }
  const orderedCardTree = computed<readonly CardTreeNode[]>(() => { const root = hierarchySlicesByParentId.value.project?.parent; if (!root) return []; const build = (card: CardHierarchyRecord, path: string | null): CardTreeNode => { const slice = hierarchySlicesByParentId.value[card.id]; const childNodes = slice ? slice.children.map((child, index) => build(child, path === null ? String(index + 1) : `${path}.${index + 1}`)) : []; return Object.freeze({ card, logicalPath: path, childNodes: Object.freeze(childNodes) }); }; return [build(root, null)]; });
  function hierarchyPathFor(id: string): string | null { const visit = (nodes: readonly CardTreeNode[]): string | null => { for (const node of nodes) { if (node.card.id === id) return node.logicalPath; const found = visit(node.childNodes); if (found !== null) return found; } return null; }; return id === 'project' && orderedCardTree.value.length ? '' : visit(orderedCardTree.value); }
  function isHierarchyCardRepresented(id: string): boolean { return id === 'project' ? !!orderedCardTree.value.length : hierarchyPathFor(id) !== null; }

  function startChildren(id: string, reason: StaleReason | null): Promise<void> {
    const existing = childrenRequestOwnersByParentId.get(id);
    if (reason === null && existing) return existing.promise;
    existing?.controller.abort();
    let resolveOwner!: () => void; let rejectOwner!: (error: unknown) => void;
    const native = new Promise<void>((resolve, reject) => { resolveOwner = resolve; rejectOwner = reject; });
    const owner: RequestOwner = markRaw({ controller: new AbortController(), promise: stableActionPromise(native) });
    childrenRequestOwnersByParentId.set(id, owner);
    const accepted = !!hierarchySlicesByParentId.value[id];
    setChildrenState(id, accepted ? { status: hierarchySlicesByParentId.value[id]!.children.length ? 'loaded-nonempty' : 'confirmed-leaf', error: null, refreshing: true, stale: true, staleReason: reason, refreshError: null } : { ...undiscoveredChildren(), status: 'loading' });
    void Promise.resolve().then(() => getCardChildren(id, owner.controller.signal)).then((response) => {
      if (childrenRequestOwnersByParentId.get(id) !== owner) return resolveOwner();
      if (response.parent.id !== id) throw new Error(`Hierarchy response parent '${response.parent.id}' does not match '${id}'.`);
      hierarchySlicesByParentId.value = { ...hierarchySlicesByParentId.value, [id]: Object.freeze({ parent: response.parent, children: Object.freeze([...response.children]) }) };
      setChildrenState(id, { status: response.children.length ? 'loaded-nonempty' : 'confirmed-leaf', error: null, ...fresh() }); resolveOwner();
    }).catch((error: unknown) => {
      if (childrenRequestOwnersByParentId.get(id) !== owner || aborted(error)) return resolveOwner();
      if (accepted) { setChildrenState(id, { status: hierarchySlicesByParentId.value[id]!.children.length ? 'loaded-nonempty' : 'confirmed-leaf', error: null, refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: message(error, 'Failed to refresh card children') }); resolveOwner(); }
      else { setChildrenState(id, { ...undiscoveredChildren(), status: 'error', error: message(error, 'Failed to load card children') }); rejectOwner(error); }
    }).finally(() => { if (childrenRequestOwnersByParentId.get(id) === owner) childrenRequestOwnersByParentId.delete(id); });
    return owner.promise;
  }
  function ensureChildren(id: string): Promise<void> { const state = childrenLoadState(id); if (state.status === 'loaded-nonempty' || state.status === 'confirmed-leaf' || state.status === 'error') return Promise.resolve(); return startChildren(id, null); }
  function ensureRoot(): Promise<void> { return ensureChildren('project'); }
  function refreshChildren(id: string, reason: Exclude<StaleReason, 'refresh-failed'>): Promise<void> { if (!hierarchySlicesByParentId.value[id]) throw new Error(`Children for '${id}' have no accepted slice.`); return startChildren(id, reason); }
  function retryChildren(id: string): Promise<void> { const state = childrenLoadState(id); if (state.status === 'error') { const next = { ...childrenLoadStateById.value }; delete next[id]; childrenLoadStateById.value = next; return ensureChildren(id); } if (state.staleReason === 'refresh-failed') return refreshChildren(id, 'invalidated'); throw new Error(`Children for '${id}' are not retryable.`); }

  async function ensureRouteVisible(id: string): Promise<void> { const token = ++revealSeq; const chain = cardRouteChain(id); for (let index = 0; index < chain.length - 1; index += 1) { if (token !== revealSeq) return; const parent = chain[index]!; const state = childrenLoadState(parent); if (state.status === 'error' || state.stale) return; if (state.status !== 'loaded-nonempty' && state.status !== 'confirmed-leaf') { try { await ensureChildren(parent); } catch { return; } if (token !== revealSeq || childrenLoadState(parent).stale) return; } if (!hierarchySlicesByParentId.value[parent]?.children.some((child) => child.id === chain[index + 1])) return; } }

  function clearSelectedSubordinates(): void {
    descriptorOwner?.controller.abort(); descriptorOwner = null;
    abortRequestOwners(recordOwners);
    abortRequestOwners(recordHistoryOwners); abortRequestOwners(recordVersionOwners); abortRequestOwners(recordDiffOwners);
    recordDescriptors.value = []; recordDescriptorsLoading.value = false; recordDescriptorsError.value = null; cardRecords.value = emptyRecords(); cardHistoryVisible.value = false; clearCardHistoryState();
  }
  function clearSelectionData(): void {
    detailOwner?.controller.abort(); detailOwner = null;
    selectedDetail.value = null; selectedDetailLoading.value = false; selectedDetailError.value = null; selectedDetailFreshness.value = fresh(); clearSelectedSubordinates();
  }
  function clearCardSelection(): void { ++revealSeq; clearSelectionData(); selectedCardId.value = null; }
  function selectOwner(id: string): void { if (selectedCardId.value === id) return; clearSelectionData(); selectedCardId.value = id; }
  function startDetail(id: string, reason: StaleReason | null): Promise<void> {
    selectOwner(id); detailOwner?.controller.abort();
    const accepted = selectedDetail.value?.cardId === id; const controller = new AbortController(); let owner!: RequestOwner;
    const promise = getCard(id, controller.signal).then((response) => { if (detailOwner !== owner || selectedCardId.value !== id) return; selectedDetail.value = Object.freeze({ cardId: id, card: response.card }); selectedDetailError.value = null; selectedDetailFreshness.value = fresh(); if (!recordDescriptors.value.length && !descriptorOwner) void loadRecordDescriptors(id); }).catch((error: unknown) => {
      if (detailOwner !== owner || selectedCardId.value !== id || aborted(error)) return;
      if (error instanceof OperatorApiError && error.isNotFound) {
        clearSelectedSubordinates(); selectedDetail.value = null; selectedDetailLoading.value = false; selectedDetailError.value = buildDetailError(error, 'Failed to fetch card detail'); selectedDetailFreshness.value = fresh(); return;
      }
      if (accepted) selectedDetailFreshness.value = { refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: message(error, 'Failed to refresh card detail') }; else selectedDetailError.value = buildDetailError(error, 'Failed to fetch card detail');
    }).finally(() => { if (detailOwner === owner) { selectedDetailLoading.value = false; selectedDetailFreshness.value.refreshing = false; detailOwner = null; } });
    owner = markRaw({ controller, promise }); detailOwner = owner; selectedDetailLoading.value = !accepted; selectedDetailError.value = null; if (accepted) selectedDetailFreshness.value = { refreshing: true, stale: true, staleReason: reason, refreshError: null }; return promise;
  }
  function fetchCardDetail(id: string): Promise<void> { return startDetail(id, selectedDetail.value?.cardId === id ? 'invalidated' : null); }
  function refreshCardDetail(reason: Exclude<StaleReason, 'refresh-failed'>): Promise<void> { if (!selectedCardId.value || !selectedDetail.value) throw new Error('No accepted selected detail.'); return startDetail(selectedCardId.value, reason); }
  function retryCardDetail(): Promise<void> { if (selectedDetailFreshness.value.staleReason !== 'refresh-failed') throw new Error('Detail is not retryable.'); return refreshCardDetail('invalidated'); }

  function loadRecordDescriptors(cardId: string, preserveAccepted = false): Promise<void> {
    if (selectedCardId.value !== cardId || selectedDetail.value?.cardId !== cardId) throw new Error(`Card detail for '${cardId}' is not loaded.`);
    descriptorOwner?.controller.abort(); const controller = new AbortController(); let owner!: RequestOwner;
    const promise = listCardRecords(cardId, controller.signal).then((response) => { if (descriptorOwner !== owner || selectedCardId.value !== cardId) return; const prior=cardRecords.value; recordDescriptors.value = Object.freeze([...response.records]); cardRecords.value = preserveAccepted ? Object.fromEntries(response.records.map((descriptor)=>{const value=prior[descriptor.name];return [descriptor.name,value&&sameDescriptor(value.descriptor,descriptor)?{...value,descriptor}:emptyRecordState(descriptor)];})) : recordsFrom(response.records); recordDescriptorsError.value = null; }).catch((error: unknown) => { if (descriptorOwner === owner && !aborted(error)) recordDescriptorsError.value = message(error, 'Failed to load record descriptors'); }).finally(() => { if (descriptorOwner === owner) { descriptorOwner = null; recordDescriptorsLoading.value = false; } });
    owner = markRaw({ controller, promise }); descriptorOwner = owner; recordDescriptorsLoading.value = true; recordDescriptorsError.value = null; return promise;
  }
  function startRecord(cardId: string, name: LiveSyncCardRecordName, reason: StaleReason | null): Promise<void> {
    if (selectedCardId.value !== cardId) throw new Error(`Records are not owned by '${cardId}'.`);
    const prior=cardRecords.value[name];if(!prior)throw new Error(`Record '${name}' is not configured for '${cardId}'.`);
    abortRequestOwner(recordOwners, name); const accepted = prior.accepted; const controller = new AbortController(); let owner!: RequestOwner;
    const promise = getCardRecord(cardId, name, controller.signal).then((response) => { if (recordOwners.get(name) !== owner || selectedCardId.value !== cardId) return; const effective=response.record.effective_content_source==='draft'?response.record.draft:response.record.effective_content_source==='accepted'?response.record.accepted:null; const committedAt=response.record.effective_content_source==='draft'?response.record.draft!.updated_at:response.record.accepted?.committed_at; cardRecords.value = withKey(cardRecords.value, name, { ...prior,current:response,loading: false, error: null, accepted: effective ? { kind: 'content', version: response.record.head_version, committedAt: committedAt!, content: effective.content } : {kind:'empty'}, ...fresh() }); }).catch((error: unknown) => {
      if (recordOwners.get(name) !== owner || selectedCardId.value !== cardId || aborted(error)) return;
      const optionalEmpty404 = isOperatorApiError(error, 'cards.records.get', 404)
        && error.data.error === 'Card record not found'
        && error.data.cardId === cardId
        && error.data.name === name
        && !prior.descriptor.bootstrap
        && (accepted === null || accepted.kind === 'empty');
      if (optionalEmpty404) cardRecords.value = withKey(cardRecords.value, name, { ...prior,loading: false, error: null, accepted: { kind: 'empty' }, ...fresh() });
      else if (accepted) cardRecords.value = withKey(cardRecords.value, name, { ...prior, loading: false, refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: message(error, `Failed to refresh ${name}`) });
      else cardRecords.value = withKey(cardRecords.value, name, { ...emptyRecordState(prior.descriptor), error: message(error, `Failed to load ${name}`) });
    }).finally(() => { releaseRequestOwner(recordOwners, name, owner); });
    owner = markRaw({ controller, promise }); replaceRequestOwner(recordOwners, name, owner); cardRecords.value = withKey(cardRecords.value, name, accepted ? { ...prior, loading: false, refreshing: true, stale: true, staleReason: reason, refreshError: null } : { ...prior, loading: true, error: null }); return promise;
  }
  async function loadCardRecords(cardId: string): Promise<void> { if(selectedCardId.value!==cardId||selectedDetail.value?.cardId!==cardId)throw new Error(`Card detail for '${cardId}' is not loaded.`); if (descriptorOwner) await descriptorOwner.promise; if (recordDescriptorsError.value) return; await Promise.all(recordDescriptors.value.map((record)=>startRecord(cardId,record.name,null))); }
  function refreshRecord(name: LiveSyncCardRecordName, reason: Exclude<StaleReason, 'refresh-failed'>): Promise<void> { const id = selectedCardId.value; if (!id || !cardRecords.value[name]?.accepted) throw new Error(`No accepted ${name} record.`); return startRecord(id, name, reason); }
  function retryRecord(name: LiveSyncCardRecordName): Promise<void> { if (cardRecords.value[name]?.staleReason !== 'refresh-failed') throw new Error(`${name} is not retryable.`); return refreshRecord(name, 'invalidated'); }
  function openRecordHistory(name: LiveSyncCardRecordName):Promise<void>{
    const id=selectedCardId.value;const prior=cardRecords.value[name];if(!id||!prior)throw new Error(`Record '${name}' is not selected.`);
    abortRequestOwner(recordHistoryOwners,name);const controller=new AbortController();let owner!:RequestOwner;
    const promise=listRecordHistory(id,name,controller.signal).then((history)=>{if(recordHistoryOwners.get(name)!==owner||selectedCardId.value!==id)return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,history,historyLoading:false,historyError:null});}).catch((error:unknown)=>{if(recordHistoryOwners.get(name)!==owner||aborted(error))return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,historyLoading:false,historyError:message(error,'Failed to load record history')});}).finally(()=>releaseRequestOwner(recordHistoryOwners,name,owner));
    owner=markRaw({controller,promise});replaceRequestOwner(recordHistoryOwners,name,owner);cardRecords.value=withKey(cardRecords.value,name,{...prior,historyLoading:true,historyError:null});return promise;
  }
  function currentAsSelected(current:CardRecordContentResponse):RecordVersionContentResponse {
    const record=current.record;const published_at=record.state==='open'?record.draft!.updated_at:record.state==='closed'?record.accepted!.committed_at:record.discarded!.discarded_at;
    return {card_id:current.card_id,name:record.name,version:record.head_version,entry_id:record.head_entry_id,published_at,artifact:{state:record.state,published_at,accepted:record.accepted,draft:record.draft,discarded:record.discarded}};
  }
  function selectRecordVersion(name:LiveSyncCardRecordName,version:number):Promise<void>{
    const id=selectedCardId.value;const prior=cardRecords.value[name];if(!id||!prior)throw new Error(`Record '${name}' is not selected.`);
    abortRequestOwner(recordVersionOwners,name);abortRequestOwner(recordDiffOwners,name);
    if(prior.current?.record.head_version===version){const selected=currentAsSelected(prior.current);const diff:RecordDiffResponse={card_id:id,name,from:version,to:version,view:'effective',hunks:[]};cardRecords.value=withKey(cardRecords.value,name,{...prior,selectedVersion:version,selected,selectedLoading:false,selectedError:null,diff,diffLoading:false,diffError:null});return Promise.resolve();}
    cardRecords.value=withKey(cardRecords.value,name,{...prior,selectedVersion:version,selected:null,selectedLoading:true,selectedError:null,diff:null,diffLoading:true,diffError:null});
    const versionController=new AbortController();let versionOwner!:RequestOwner;const versionPromise=getRecordVersion(id,name,version,versionController.signal).then((selected)=>{if(recordVersionOwners.get(name)!==versionOwner||selectedCardId.value!==id||cardRecords.value[name]?.selectedVersion!==version)return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,selected,selectedLoading:false,selectedError:null});}).catch((error:unknown)=>{if(recordVersionOwners.get(name)!==versionOwner||aborted(error))return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,selectedLoading:false,selectedError:message(error,'Historical record unavailable')});}).finally(()=>releaseRequestOwner(recordVersionOwners,name,versionOwner));versionOwner=markRaw({controller:versionController,promise:versionPromise});replaceRequestOwner(recordVersionOwners,name,versionOwner);
    const diffController=new AbortController();let diffOwner!:RequestOwner;const diffPromise=getRecordDiff(id,name,version,'current','effective',diffController.signal).then((diff)=>{if(recordDiffOwners.get(name)!==diffOwner||selectedCardId.value!==id||cardRecords.value[name]?.selectedVersion!==version)return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,diff,diffLoading:false,diffError:null});}).catch((error:unknown)=>{if(recordDiffOwners.get(name)!==diffOwner||aborted(error))return;cardRecords.value=withKey(cardRecords.value,name,{...cardRecords.value[name]!,diffLoading:false,diffError:message(error,'Record diff unavailable')});}).finally(()=>releaseRequestOwner(recordDiffOwners,name,diffOwner));diffOwner=markRaw({controller:diffController,promise:diffPromise});replaceRequestOwner(recordDiffOwners,name,diffOwner);
    return Promise.all([versionPromise,diffPromise]).then(()=>undefined);
  }

  function startHistory(cardId: string, reason: StaleReason | null): Promise<void> {
    if (selectedCardId.value !== cardId || !cardHistoryVisible.value) return Promise.resolve(); historyOwner?.controller.abort(); const accepted = cardHistoryAccepted.value; const controller = new AbortController(); let owner!: RequestOwner;
    const promise = listCardHistory(cardId, controller.signal).then((response) => { if (historyOwner !== owner || selectedCardId.value !== cardId || !cardHistoryVisible.value) return; cardHistory.value = response.versions; cardHistoryAccepted.value = true; cardHistoryError.value = null; cardHistoryFreshness.value = fresh(); }).catch((error: unknown) => { if (historyOwner !== owner || aborted(error)) return; if (accepted) cardHistoryFreshness.value = { refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: message(error, 'Failed to refresh card history') }; else cardHistoryError.value = buildDetailError(error, 'Failed to load card history'); }).finally(() => { if (historyOwner === owner) { cardHistoryLoading.value = false; cardHistoryFreshness.value.refreshing = false; historyOwner = null; } });
    owner = markRaw({ controller, promise }); historyOwner = owner; cardHistoryLoading.value = !accepted; if (accepted) cardHistoryFreshness.value = { refreshing: true, stale: true, staleReason: reason, refreshError: null }; return promise;
  }
  function openCardHistory(cardId: string): Promise<void> { selectOwner(cardId); cardHistoryVisible.value = true; return startHistory(cardId, null); }
  function fetchCardHistoryForCard(cardId: string): Promise<void> { if (!cardHistoryVisible.value) cardHistoryVisible.value = true; return startHistory(cardId, cardHistory.value.length ? 'invalidated' : null); }
  function refreshHistory(reason: Exclude<StaleReason, 'refresh-failed'>): Promise<void> { if (!selectedCardId.value || !cardHistoryVisible.value || !cardHistoryAccepted.value) throw new Error('No accepted visible history.'); return startHistory(selectedCardId.value, reason); }
  function retryHistory(): Promise<void> { if (cardHistoryFreshness.value.staleReason !== 'refresh-failed') throw new Error('History is not retryable.'); return refreshHistory('invalidated'); }
  function closeCardHistory(): void { cardHistoryVisible.value = false; clearCardHistoryState(); }
  function clearCardHistoryState(): void { historyOwner?.controller.abort(); entryOwner?.controller.abort(); diffOwner?.controller.abort(); historyOwner = entryOwner = diffOwner = null; cardHistory.value = []; cardHistoryAccepted.value = false; cardHistoryLoading.value = false; cardHistoryError.value = null; cardHistoryFreshness.value = fresh(); cardHistorySelectedVersion.value = null; cardHistoryEntry.value = null; cardHistoryEntryLoading.value = false; cardHistoryEntryError.value = null; cardHistoryDiff.value = []; cardHistoryDiffKey.value = null; cardHistoryDiffLoading.value = false; cardHistoryDiffError.value = null; cardHistoryDiffFreshness.value = fresh(); }

  function startEntry(cardId: string, version: number): Promise<void> { entryOwner?.controller.abort(); const controller = new AbortController(); let owner!: RequestOwner; const promise = getCardHistoryEntry(cardId, version, controller.signal).then((response) => { if (entryOwner === owner && selectedCardId.value === cardId && cardHistorySelectedVersion.value === version) { cardHistoryEntry.value = response; cardHistoryEntryError.value = null; } }).catch((error: unknown) => { if (entryOwner === owner && !aborted(error)) cardHistoryEntryError.value = buildDetailError(error, 'Failed to load card history entry'); }).finally(() => { if (entryOwner === owner) { cardHistoryEntryLoading.value = false; entryOwner = null; } }); owner = markRaw({ controller, promise }); entryOwner = owner; cardHistoryEntryLoading.value = true; return promise; }
  function startDiff(key: CurrentCardDiffKey, reason: StaleReason | null): Promise<void> { diffOwner?.controller.abort(); const accepted = cardHistoryDiffKey.value?.cardId === key.cardId && cardHistoryDiffKey.value.fromSeq === key.fromSeq; const controller = new AbortController(); let owner!: RequestOwner; const promise = getCardDiff(key, controller.signal).then((response) => { if (diffOwner !== owner || selectedCardId.value !== key.cardId || cardHistorySelectedVersion.value !== key.fromSeq) return; cardHistoryDiff.value = response.diff; cardHistoryDiffKey.value = key; cardHistoryDiffError.value = null; cardHistoryDiffFreshness.value = fresh(); }).catch((error: unknown) => { if (diffOwner !== owner || aborted(error)) return; if (accepted) cardHistoryDiffFreshness.value = { refreshing: false, stale: true, staleReason: 'refresh-failed', refreshError: message(error, 'Failed to refresh current diff') }; else cardHistoryDiffError.value = buildDetailError(error, 'Failed to load current diff'); }).finally(() => { if (diffOwner === owner) { cardHistoryDiffLoading.value = false; cardHistoryDiffFreshness.value.refreshing = false; diffOwner = null; } }); owner = markRaw({ controller, promise }); diffOwner = owner; cardHistoryDiffLoading.value = !accepted; if (accepted) cardHistoryDiffFreshness.value = { refreshing: true, stale: true, staleReason: reason, refreshError: null }; return promise; }
  function selectCardHistoryVersion(cardId: string, version: number): Promise<void> { cardHistorySelectedVersion.value = version; const key = Object.freeze({ cardId, fromSeq: version, to: 'current' as const }); return Promise.all([startEntry(cardId, version), startDiff(key, null)]).then(() => undefined); }
  function refreshDiff(reason: Exclude<StaleReason, 'refresh-failed'>): Promise<void> { if (!cardHistoryDiffKey.value || !cardHistoryVisible.value) throw new Error('No accepted visible current diff.'); return startDiff(cardHistoryDiffKey.value, reason); }
  function retryDiff(): Promise<void> { if (cardHistoryDiffFreshness.value.staleReason !== 'refresh-failed') throw new Error('Diff is not retryable.'); return refreshDiff('invalidated'); }

  function onInvalidate(target: LiveSyncCardInvalidateTarget): void {
    if (target.scope === 'children') { if (hierarchySlicesByParentId.value[target.card_id]) void refreshChildren(target.card_id, 'invalidated'); return; }
    if (target.card_id !== selectedCardId.value) return;
    if (target.scope === 'detail') { if (selectedDetail.value) void refreshCardDetail('invalidated'); return; }
    if (target.scope === 'record') { if (cardRecords.value[target.record_name]?.accepted) void refreshRecord(target.record_name, 'invalidated'); return; }
    if (target.scope === 'history') { if (cardHistoryVisible.value && cardHistoryAccepted.value) void refreshHistory('invalidated'); return; }
    if (target.scope === 'diff' && cardHistoryVisible.value && cardHistoryDiffKey.value) void refreshDiff('invalidated');
  }
  function onReconnect(): void {
    for (const id of Object.keys(hierarchySlicesByParentId.value)) if (childrenLoadState(id).staleReason !== 'refresh-failed') void refreshChildren(id, 'reconnect');
    if (selectedDetail.value && selectedDetailFreshness.value.staleReason !== 'refresh-failed') { const id = selectedDetail.value.cardId; void refreshCardDetail('reconnect'); void loadRecordDescriptors(id,true).then(() => selectedCardId.value === id ? loadCardRecords(id) : undefined); }
    if (cardHistoryVisible.value && cardHistoryAccepted.value && cardHistoryFreshness.value.staleReason !== 'refresh-failed') void refreshHistory('reconnect');
    if (cardHistoryVisible.value && cardHistoryDiffKey.value && cardHistoryDiffFreshness.value.staleReason !== 'refresh-failed') void refreshDiff('reconnect');
  }
  function reset(): void { ++revealSeq; abortRequestOwners(childrenRequestOwnersByParentId); clearSelectionData(); selectedCardId.value = null; hierarchySlicesByParentId.value = {}; childrenLoadStateById.value = {}; }
  return { hierarchySlicesByParentId, childrenLoadStateById, childrenRequestOwnersByParentId, selectedCardId, selectedDetail, selectedDetailLoading, selectedDetailError, selectedDetailFreshness, orderedCardTree, cardRecords, recordDescriptors, recordDescriptorsLoading, recordDescriptorsError, cardHistory, cardHistoryLoading, cardHistoryError, cardHistoryFreshness, cardHistoryVisible, cardHistorySelectedVersion, cardHistoryEntry, cardHistoryEntryLoading, cardHistoryEntryError, cardHistoryDiff, cardHistoryDiffKey, cardHistoryDiffLoading, cardHistoryDiffError, cardHistoryDiffFreshness, childrenLoadState, loadedChildrenFor, hierarchyCardById, hierarchyPathFor, isHierarchyCardRepresented, ensureChildren, ensureRoot, refreshChildren, retryChildren, ensureRouteVisible, clearCardSelection, fetchCardDetail, refreshCardDetail, retryCardDetail, loadRecordDescriptors, loadCardRecords, refreshRecord, retryRecord, openRecordHistory,selectRecordVersion,openCardHistory, closeCardHistory, fetchCardHistoryForCard, refreshHistory, retryHistory, selectCardHistoryVersion, refreshDiff, retryDiff, clearCardHistoryState, onInvalidate, onReconnect, reset };
});
