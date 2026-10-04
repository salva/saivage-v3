import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getCardChildren: vi.fn(), getCard: vi.fn(), listCardRecords: vi.fn(), getCardRecord: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  listRecordHistory: vi.fn(), getRecordVersion: vi.fn(), getRecordDiff: vi.fn(),
}));

import { OperatorApiError, getCard, getCardChildren, getCardDiff, getCardHistoryEntry, getCardRecord, listCardHistory, listCardRecords, listRecordHistory, getRecordVersion, getRecordDiff } from '../api/client';
import { cardRouteChain, useCardStore } from '../stores/cards';
import { cardView, hierarchyView, historyCard } from './card-view-fixtures';

const A='card-a';
const descriptors=[
  {name:'brief.md',format:'markdown' as const,schema:'brief.v1',bootstrap:true,current:null},
  {name:'research-findings.md',format:'markdown' as const,schema:'research.v1',bootstrap:false,current:null},
  {name:'decision.md',format:'markdown' as const,schema:'decision.v1',bootstrap:false,current:null},
];
const content=(cardId:string,name:string,text='accepted')=>({card_id:cardId,record:{name,revision:2,current_url:`record:///${name}?card=${cardId}`,accepted_version_url:`record:///${name}?card=${cardId}&v=2`,state:'closed' as const,accepted:{source_version:2,source_entry_id:'11111111-1111-4111-8111-111111111111',committed_at:'2026-07-22T00:00:00.000Z',writer_agent:'analyst',card_version_seq:1,card_history_version:1,card_history_entry_id:'11111111-1111-4111-8111-111111111111',content:text,content_sha256:'a'.repeat(64),size_bytes:text.length},draft:null,effective_content_source:'accepted' as const}});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('CardStore exact card resources',()=>{
  beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});

  it('reads real accepted history even at the current revision, and never synthesizes draft history or substitutes gaps', async () => {
    const current = content(A, 'brief.md', 'accepted objective');
    const accepted = current.record.accepted;
    const historical = { card_id: A, name: 'brief.md', version: 2, version_url: current.record.accepted_version_url, entry_id: accepted.source_entry_id, published_at: accepted.committed_at, artifact: { published_at: accepted.committed_at, accepted } };
    vi.mocked(getCard).mockResolvedValue({ card: cardView(A, { version_seq: 3 }) });
    vi.mocked(listCardRecords).mockResolvedValue({ card_id: A, records: [descriptors[0]!] });
    vi.mocked(getCardRecord).mockResolvedValue(current);
    vi.mocked(listRecordHistory).mockResolvedValue({ card_id: A, name: 'brief.md', versions: [{ entry_id: accepted.source_entry_id, version: 2, published_at: accepted.committed_at, version_url: historical.version_url }], total: 1 });
    vi.mocked(getRecordVersion).mockResolvedValue(historical);
    vi.mocked(getRecordDiff).mockResolvedValue({ card_id: A, name: 'brief.md', from: 2, to: { kind: 'current', revision: 2, accepted_version: 2 }, view: 'effective', hunks: [] });
    const store = useCardStore();
    await store.fetchCardDetail(A); await store.loadCardRecords(A); await store.openRecordHistory('brief.md');
    await store.selectRecordVersion('brief.md', 2);
    expect(getRecordVersion).toHaveBeenCalledWith(A, 'brief.md', 2, expect.any(AbortSignal));
    expect(store.cardRecords['brief.md']!.selected).toEqual(historical);
    const draftTime = '2026-07-23T00:00:00.000Z';
    vi.mocked(getCardRecord).mockResolvedValue({ ...current, record: { ...current.record, revision: 3, state: 'open', draft: { content: 'unfinished draft', content_sha256: 'b'.repeat(64), opened_at: accepted.committed_at, updated_at: draftTime }, effective_content_source: 'draft' } });
    await store.refreshRecord('brief.md', 'invalidated');
    const missing = { error: 'historical_version_not_found' as const, resource: 'authored_record' as const, owner_id: `${A}/brief.md`, version: 3 };
    vi.mocked(getRecordVersion).mockRejectedValueOnce(new OperatorApiError('cards.records.versions.get', 404, missing));
    vi.mocked(getRecordDiff).mockRejectedValueOnce(new OperatorApiError('cards.records.diff', 404, missing));
    await store.selectRecordVersion('brief.md', 3);
    expect(store.cardRecords['brief.md']!.content).toEqual({ kind: 'content', revision: 3, timestamp: draftTime, content: 'unfinished draft' });
    expect(store.cardRecords['brief.md']!.current?.record.accepted?.source_version).toBe(2);
    expect(store.cardRecords['brief.md']!.current?.record.draft?.content).toBe('unfinished draft');
    expect(store.cardRecords['brief.md']!.selected).toBeNull();
    expect(store.cardRecords['brief.md']!.selectedVersion).toBe(3);
    expect(store.cardRecords['brief.md']!.selectedError).toBe('historical_version_not_found');
    expect(store.cardRecords['brief.md']!.diffError).toBe('historical_version_not_found');
    expect(store.cardRecords['brief.md']!.diff).toBeNull();
    expect(getRecordVersion).toHaveBeenCalledTimes(2);
    expect(getRecordVersion).toHaveBeenLastCalledWith(A, 'brief.md', 3, expect.any(AbortSignal));
    expect(getRecordDiff).toHaveBeenCalledTimes(2);
    expect(getRecordDiff).toHaveBeenLastCalledWith(A, 'brief.md', 3, 'current', 'effective', expect.any(AbortSignal));
    // A partial catalog cannot veto an exact server success either.
    store.cardRecords['brief.md']!.history = { card_id: A, name: 'brief.md', versions: [], total: 0 };
    await store.selectRecordVersion('brief.md', 2);
    expect(store.cardRecords['brief.md']!.selected).toEqual(historical);
    expect(store.cardRecords['brief.md']!.diff?.from).toBe(2);
    expect(store.cardRecords['brief.md']!.selectedError).toBeNull();
    expect(store.cardRecords['brief.md']!.diffError).toBeNull();
  });

  it('fences both pending exact responses when a newer catalog-gap selection fails', async () => {
    const current = content(A, 'brief.md');
    vi.mocked(getCard).mockResolvedValue({ card: cardView(A) });
    vi.mocked(listCardRecords).mockResolvedValue({ card_id: A, records: [descriptors[0]!] });
    vi.mocked(getCardRecord).mockResolvedValue(current);
    vi.mocked(listRecordHistory).mockResolvedValue({ card_id: A, name: 'brief.md', versions: [], total: 0 });
    const oldVersion = deferred<Awaited<ReturnType<typeof getRecordVersion>>>();
    const oldDiff = deferred<Awaited<ReturnType<typeof getRecordDiff>>>();
    vi.mocked(getRecordVersion).mockReturnValueOnce(oldVersion.promise);
    vi.mocked(getRecordDiff).mockReturnValueOnce(oldDiff.promise);
    const store = useCardStore();
    await store.fetchCardDetail(A); await store.loadCardRecords(A); await store.openRecordHistory('brief.md');
    const oldSelection = store.selectRecordVersion('brief.md', 2);
    const versionSignal = vi.mocked(getRecordVersion).mock.calls.at(-1)![3]!;
    const diffSignal = vi.mocked(getRecordDiff).mock.calls.at(-1)![5]!;
    const missing = { error: 'historical_version_not_found' as const, resource: 'authored_record' as const, owner_id: `${A}/brief.md`, version: 3 };
    vi.mocked(getRecordVersion).mockRejectedValueOnce(new OperatorApiError('cards.records.versions.get', 404, missing));
    vi.mocked(getRecordDiff).mockRejectedValueOnce(new OperatorApiError('cards.records.diff', 404, missing));
    await store.selectRecordVersion('brief.md', 3);
    expect(versionSignal.aborted).toBe(true); expect(diffSignal.aborted).toBe(true);
    const accepted = current.record.accepted;
    oldVersion.resolve({ card_id: A, name: 'brief.md', version: 2, version_url: current.record.accepted_version_url, entry_id: accepted.source_entry_id, published_at: accepted.committed_at, artifact: { published_at: accepted.committed_at, accepted } });
    oldDiff.resolve({ card_id: A, name: 'brief.md', from: 2, to: { kind: 'current', revision: 2, accepted_version: 2 }, view: 'effective', hunks: [] });
    await oldSelection;
    expect(store.cardRecords['brief.md']).toMatchObject({ selectedVersion: 3, selected: null, diff: null, selectedError: 'historical_version_not_found', diffError: 'historical_version_not_found' });
  });

  it('builds route chains through depth twelve and rejects invalid deeper routes',()=>{
    const parts=Array.from({length:12},()=> 'a');
    const id=`card-${parts.join('-')}`;
    expect(cardRouteChain(id)).toEqual(['project',...parts.map((_part,index)=>`card-${parts.slice(0,index+1).join('-')}`)]);
    expect(cardRouteChain(`${id}-a`)).toEqual([]);
    expect(cardRouteChain('card-a-1')).toEqual([]);
  });

  it('accepts one hierarchy slice without child lookahead and confirms leaves only after discovery',async()=>{
    vi.mocked(getCardChildren).mockResolvedValueOnce({parent:hierarchyView('project'),children:[hierarchyView('card-b'),hierarchyView(A)]}).mockResolvedValueOnce({parent:hierarchyView(A),children:[]});
    const store=useCardStore(); await store.ensureRoot();
    expect(store.hierarchyPathFor('card-b')).toBe('1'); expect(store.childrenLoadState(A).status).toBe('undiscovered'); expect(getCardChildren).toHaveBeenCalledTimes(1);
    await store.ensureChildren(A); expect(store.childrenLoadState(A).status).toBe('confirmed-leaf'); expect(getCardChildren).toHaveBeenLastCalledWith(A,expect.any(AbortSignal));
  });

  it('loads descriptors separately, then exact record resources and maps only exact optional missing errors to empty',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>{if(name==='research-findings.md')throw new OperatorApiError('cards.records.get',404,{error:'card_record_not_found',cardId,name});return content(cardId,name,name);});
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(getCard).toHaveBeenCalledTimes(1); expect(listCardRecords).toHaveBeenCalledTimes(1); expect(getCardRecord).toHaveBeenCalledTimes(3);
    expect(vi.mocked(listCardRecords).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getCardRecord).mock.invocationCallOrder[0]!);
    expect(store.cardRecords['research-findings.md']!.content).toEqual({kind:'empty'}); expect(store.cardRecords['decision.md']!.content).toMatchObject({kind:'content',revision:2});
  });

  it('keeps bootstrap and nonexact 404 failures as errors',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(_cardId,name)=>{throw new OperatorApiError('cards.records.get',404,name==='brief.md'?{error:'card_record_not_found',cardId:A,name}:name==='research-findings.md'?{error:'card_record_not_found',cardId:'card-b',name}:{error:'Card not found',cardId:A});});
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(store.cardRecords['brief.md']!.content).toBeNull(); expect(store.cardRecords['brief.md']!.error).toBe('card_record_not_found');
    expect(store.cardRecords['research-findings.md']!.content).toBeNull(); expect(store.cardRecords['research-findings.md']!.error).toBe('card_record_not_found');
  });

  it('retries only the exact initially failed record while preserving unrelated outcomes',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>{
      if(name==='brief.md')throw new OperatorApiError('cards.records.get',404,{error:'card_record_not_found',cardId,name});
      if(name==='research-findings.md')throw new OperatorApiError('cards.records.get',404,{error:'card_record_not_found',cardId,name});
      return content(cardId,name,name);
    });
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(store.cardRecords['brief.md']!.error).toBe('card_record_not_found');
    expect(store.cardRecords['research-findings.md']!.content).toEqual({kind:'empty'});
    expect(store.cardRecords['decision.md']!.content).toMatchObject({kind:'content',content:'decision.md'});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name,'retried objective'));

    await store.retryRecord('brief.md');

    expect(getCardRecord).toHaveBeenCalledTimes(4);
    expect(getCardRecord).toHaveBeenLastCalledWith(A,'brief.md',expect.any(AbortSignal));
    expect(store.cardRecords['brief.md']!.content).toMatchObject({kind:'content',content:'retried objective'});
    expect(store.cardRecords['research-findings.md']!.content).toEqual({kind:'empty'});
    expect(store.cardRecords['decision.md']!.content).toMatchObject({kind:'content',content:'decision.md'});
  });

  it('does not accept a missing-record code for a different record name', async () => {
    vi.mocked(getCard).mockResolvedValue({ card: cardView(A) });
    vi.mocked(listCardRecords).mockResolvedValue({ card_id: A, records: descriptors });
    vi.mocked(getCardRecord).mockImplementation(async (cardId, name) => {
      if (name === 'research-findings.md') throw new OperatorApiError('cards.records.get', 404, {
        error: 'card_record_not_found', cardId, name: 'decision.md',
      });
      return content(cardId, name);
    });
    const store = useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(store.cardRecords['research-findings.md']!.content).toBeNull();
    expect(store.cardRecords['research-findings.md']!.error).toBe('card_record_not_found');
  });

  it('fences a selected-card load after pending descriptors before reading record content',async()=>{
    const aDescriptors=deferred<{card_id:string;records:typeof descriptors}>();
    const bDescriptors=deferred<{card_id:string;records:typeof descriptors}>();
    vi.mocked(getCard).mockImplementation(async(id)=>({card:cardView(id)}));
    vi.mocked(listCardRecords).mockImplementation((id)=>id===A?aDescriptors.promise:bDescriptors.promise);
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name));
    const store=useCardStore();
    await store.fetchCardDetail(A);
    const abandonedLoad=store.loadCardRecords(A);
    await store.fetchCardDetail('card-b');
    aDescriptors.resolve({card_id:A,records:descriptors});

    await abandonedLoad;
    expect(getCardRecord).not.toHaveBeenCalled();

    bDescriptors.resolve({card_id:'card-b',records:descriptors});
    await store.loadCardRecords('card-b');
    expect(getCardRecord).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getCardRecord).mock.calls.every(([cardId])=>cardId==='card-b')).toBe(true);
  });

  it('shares concurrent initial reads for each exact record after descriptor readiness',async()=>{
    const pendingDescriptors=deferred<{card_id:string;records:typeof descriptors}>();
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)});
    vi.mocked(listCardRecords).mockReturnValue(pendingDescriptors.promise);
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name));
    const store=useCardStore(); await store.fetchCardDetail(A);
    const first=store.loadCardRecords(A); const second=store.loadCardRecords(A);

    pendingDescriptors.resolve({card_id:A,records:descriptors});
    await Promise.all([first,second]);

    expect(getCardRecord).toHaveBeenCalledTimes(3);
    for(const descriptor of descriptors)
      expect(getCardRecord).toHaveBeenCalledWith(A,descriptor.name,expect.any(AbortSignal));
  });

  it('requires exact optional-absence identity and never discards accepted closed content',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name,`${name} accepted`));
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    vi.mocked(getCardRecord).mockImplementation(async(_cardId,name)=>{throw new OperatorApiError('cards.records.get',404,{error:'card_record_not_found',cardId:'card-b',name});});
    store.onInvalidate({resource:'cards',scope:'record',card_id:A,record_name:'research-findings.md'}); await Promise.resolve(); await Promise.resolve();
    expect(store.cardRecords['research-findings.md']!.content).toMatchObject({kind:'content',content:'research-findings.md accepted'});
    expect(store.cardRecords['research-findings.md']!.staleReason).toBe('refresh-failed');
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>{throw new OperatorApiError('cards.records.get',404,{error:'card_record_not_found',cardId,name});});
    await store.retryRecord('research-findings.md');
    expect(store.cardRecords['research-findings.md']!.content).toMatchObject({kind:'content',content:'research-findings.md accepted'});
    expect(store.cardRecords['research-findings.md']!.staleReason).toBe('refresh-failed');
  });

  it('refreshes only an accepted exact record and tears owners down on a missing selected card',async()=>{
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors}); vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name));
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A); vi.mocked(getCardRecord).mockClear();
    store.onInvalidate({resource:'cards',scope:'record',card_id:A,record_name:'decision.md'}); await Promise.resolve(); await Promise.resolve();
    expect(getCardRecord).toHaveBeenCalledTimes(1); expect(getCardRecord).toHaveBeenCalledWith(A,'decision.md',expect.any(AbortSignal));
    vi.mocked(getCard).mockRejectedValueOnce(new OperatorApiError('cards.get',404,{error:'Card not found',cardId:A})); await store.refreshCardDetail('invalidated');
    expect(store.selectedDetail).toBeNull(); expect(store.cardRecords).toEqual({}); expect(store.recordDescriptors).toEqual([]);
  });

  it('reloads compiled descriptors for a new connection epoch before refreshing mounted records',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors}); vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name));
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    vi.clearAllMocks(); vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors}); vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name,'reconnected'));
    store.onReconnect();
    await vi.waitFor(()=>expect(getCardRecord).toHaveBeenCalledTimes(3));
    expect(listCardRecords).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listCardRecords).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getCardRecord).mock.invocationCallOrder[0]!);
  });

  it('lets exact card requests resolve a partial catalog and preserves current detail on server misses', async () => {
    const store = useCardStore();
    store.selectedCardId = A;
    store.selectedDetail = { cardId: A, card: cardView(A, { title: 'current', version_seq: 4 }) };
    const current = store.selectedDetail;
    const header = { entry_id: '11111111-1111-4111-8111-111111111111', version: 1, published_at: '2026-07-22T00:00:00.000Z', artifact_kind: 'card-version' as const, change: null };
    vi.mocked(listCardHistory).mockResolvedValue({ card_id: A, versions: [header], total: 1 });
    await store.openCardHistory(A);
    const selected = { card_id: A, version: 2, entry_id: '22222222-2222-4222-8222-222222222222', published_at: header.published_at, artifact: { kind: 'card-version' as const, card: historyCard(A, { version_seq: 2 }), change: null } };
    const diff = { card_id: A, from: 2, to: { kind: 'current' as const, version_seq: 4, history_version: 2 }, diff: [{ field: 'title', before: 'old', after: 'current' }] };
    vi.mocked(getCardHistoryEntry).mockResolvedValue(selected);
    vi.mocked(getCardDiff).mockResolvedValue(diff);
    await store.selectCardHistoryVersion(A, 2);
    expect(getCardHistoryEntry).toHaveBeenLastCalledWith(A, 2, expect.any(AbortSignal));
    expect(getCardDiff).toHaveBeenLastCalledWith({ cardId: A, fromSeq: 2, to: 'current' }, expect.any(AbortSignal));
    expect(store.cardHistoryEntry).toEqual(selected);
    expect(store.cardHistoryDiff).toEqual(diff.diff);
    const missing = { error: 'historical_version_not_found' as const, resource: 'card' as const, owner_id: A, version: 3 };
    vi.mocked(getCardHistoryEntry).mockRejectedValueOnce(new OperatorApiError('cards.history.get', 404, missing));
    vi.mocked(getCardDiff).mockRejectedValueOnce(new OperatorApiError('cards.diff', 404, missing));
    await store.selectCardHistoryVersion(A, 3);
    expect(getCardHistoryEntry).toHaveBeenLastCalledWith(A, 3, expect.any(AbortSignal));
    expect(getCardDiff).toHaveBeenLastCalledWith({ cardId: A, fromSeq: 3, to: 'current' }, expect.any(AbortSignal));
    expect(store.cardHistorySelectedVersion).toBe(3);
    expect(store.cardHistoryEntry).toBeNull();
    expect(store.cardHistoryDiff).toEqual([]);
    expect(store.cardHistoryDiffTarget).toBeNull();
    expect(store.cardHistoryEntryError).toMatchObject({ kind: 'not-found', status: 404, message: 'historical_version_not_found' });
    expect(store.cardHistoryDiffError).toMatchObject({ kind: 'not-found', status: 404, message: 'historical_version_not_found' });
    expect(store.selectedDetail).toBe(current);
    expect(store.cardHistory).toEqual([header]);
  });

  it('fences pending card version and diff responses after a newer exact selection fails', async () => {
    const store = useCardStore();
    store.selectedCardId = A;
    store.selectedDetail = { cardId: A, card: cardView(A) };
    vi.mocked(listCardHistory).mockResolvedValue({ card_id: A, versions: [], total: 0 });
    await store.openCardHistory(A);
    const oldVersion = deferred<Awaited<ReturnType<typeof getCardHistoryEntry>>>();
    const oldDiff = deferred<Awaited<ReturnType<typeof getCardDiff>>>();
    vi.mocked(getCardHistoryEntry).mockReturnValueOnce(oldVersion.promise);
    vi.mocked(getCardDiff).mockReturnValueOnce(oldDiff.promise);
    const oldSelection = store.selectCardHistoryVersion(A, 2);
    const versionSignal = vi.mocked(getCardHistoryEntry).mock.calls.at(-1)![2]!;
    const diffSignal = vi.mocked(getCardDiff).mock.calls.at(-1)![1]!;
    const missing = { error: 'historical_version_not_found' as const, resource: 'card' as const, owner_id: A, version: 3 };
    vi.mocked(getCardHistoryEntry).mockRejectedValueOnce(new OperatorApiError('cards.history.get', 404, missing));
    vi.mocked(getCardDiff).mockRejectedValueOnce(new OperatorApiError('cards.diff', 404, missing));
    await store.selectCardHistoryVersion(A, 3);
    expect(versionSignal.aborted).toBe(true);
    expect(diffSignal.aborted).toBe(true);
    oldVersion.resolve({ card_id: A, version: 2, entry_id: '11111111-1111-4111-8111-111111111111', published_at: '2026-07-22T00:00:00.000Z', artifact: { kind: 'card-version', card: historyCard(A), change: null } });
    oldDiff.resolve({ card_id: A, from: 2, to: { kind: 'current', version_seq: 4, history_version: 2 }, diff: [{ field: 'title', before: 'old', after: 'stale' }] });
    await oldSelection;
    expect(store.cardHistorySelectedVersion).toBe(3);
    expect(store.cardHistoryEntry).toBeNull();
    expect(store.cardHistoryDiff).toEqual([]);
    expect(store.cardHistoryDiffTarget).toBeNull();
    expect(store.cardHistoryEntryError?.message).toBe('historical_version_not_found');
    expect(store.cardHistoryDiffError?.message).toBe('historical_version_not_found');
    expect(store.cardHistoryEntryLoading).toBe(false);
    expect(store.cardHistoryDiffLoading).toBe(false);
  });

  it('stores route-derived history metadata and queue-free selected artifacts unchanged',async()=>{
    const first={entry_id:'11111111-1111-4111-8111-111111111111',version:1,published_at:'2026-07-22T00:00:00.000Z',artifact_kind:'card-version' as const,change:null};
    const second={entry_id:'22222222-2222-4222-8222-222222222222',version:2,published_at:'2026-07-22T00:00:01.000Z',artifact_kind:'card-version' as const,change:{summary:'lifecycle updated',changed_fields:['lifecycle' as const],actor:null}};
    const selected={card_id:A,version:1,entry_id:first.entry_id,published_at:first.published_at,artifact:{kind:'card-version' as const,card:historyCard(A),change:null}};
    vi.mocked(listCardHistory).mockResolvedValue({card_id:A,versions:[first,second],total:2});
    vi.mocked(getCardHistoryEntry).mockResolvedValue(selected);
    vi.mocked(getCardDiff).mockResolvedValue({card_id:A,from:1,to:{kind:'current',version_seq:2,history_version:2},diff:[]});
    const store=useCardStore();

    await store.openCardHistory(A);
    expect(store.cardHistory).toEqual([first,second]);
    await store.selectCardHistoryVersion(A,1);
    expect(store.cardHistoryEntry).toEqual(selected);
    expect(store.cardHistoryEntry!.artifact.change).toBeNull();
    if (store.cardHistoryEntry!.artifact.kind !== 'card-version') throw new Error('Expected a card-version artifact.');
    expect(store.cardHistoryEntry!.artifact.card).not.toHaveProperty('pending_notifications');
  });
});
