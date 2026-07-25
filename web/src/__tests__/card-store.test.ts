import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  getCardChildren: vi.fn(), getCard: vi.fn(), listCardRecords: vi.fn(), getCardRecord: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { constructor(public status:number, text:string, public body:Record<string,unknown>={}) { super(text); } get isUnauthorized(){return this.status===401;} get isNotFound(){return this.status===404;} },
}));

import { ApiError, getCard, getCardChildren, getCardRecord, listCardRecords } from '../api/client';
import { useCardStore } from '../stores/cards';
import { cardView, hierarchyView } from './card-view-fixtures';

const A='card-a';
const descriptors=[
  {name:'brief.md',format:'markdown' as const,schema:'brief.v1',writers:['analyst'],bootstrap:true},
  {name:'research-findings.md',format:'markdown' as const,schema:'research.v1',writers:['researcher'],bootstrap:false},
  {name:'decision.md',format:'markdown' as const,schema:'decision.v1',writers:['reviewer'],bootstrap:false},
];
const content=(cardId:string,name:string,text='accepted')=>({card_id:cardId,record:{name,version:2,committed_at:'2026-07-22T00:00:00.000Z',content:text}});

describe('CardStore exact card resources',()=>{
  beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});

  it('accepts one hierarchy slice without child lookahead and confirms leaves only after discovery',async()=>{
    vi.mocked(getCardChildren).mockResolvedValueOnce({parent:hierarchyView('project'),children:[hierarchyView('card-b'),hierarchyView(A)]}).mockResolvedValueOnce({parent:hierarchyView(A),children:[]});
    const store=useCardStore(); await store.ensureRoot();
    expect(store.hierarchyPathFor('card-b')).toBe('1'); expect(store.childrenLoadState(A).status).toBe('undiscovered'); expect(getCardChildren).toHaveBeenCalledTimes(1);
    await store.ensureChildren(A); expect(store.childrenLoadState(A).status).toBe('confirmed-leaf'); expect(getCardChildren).toHaveBeenLastCalledWith(A,expect.any(AbortSignal));
  });

  it('loads descriptors separately, then exact record resources and maps only exact optional missing errors to empty',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>{if(name==='research-findings.md')throw new ApiError(404,'missing',{error:'Card record not found',cardId,name});return content(cardId,name,name);});
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(getCard).toHaveBeenCalledTimes(1); expect(listCardRecords).toHaveBeenCalledTimes(1); expect(getCardRecord).toHaveBeenCalledTimes(3);
    expect(vi.mocked(listCardRecords).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getCardRecord).mock.invocationCallOrder[0]!);
    expect(store.cardRecords['research-findings.md']!.accepted).toEqual({kind:'empty'}); expect(store.cardRecords['decision.md']!.accepted).toMatchObject({kind:'content',version:2});
  });

  it('keeps bootstrap and nonexact 404 failures as errors',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(_cardId,name)=>{throw new ApiError(404,'missing',name==='brief.md'?{error:'Card record not found',cardId:A,name}:name==='research-findings.md'?{error:'Card record not found',cardId:A,name,extra:true}:{error:'Card not found',cardId:A});});
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    expect(store.cardRecords['brief.md']!.accepted).toBeNull(); expect(store.cardRecords['brief.md']!.error).toBe('missing');
    expect(store.cardRecords['research-findings.md']!.accepted).toBeNull(); expect(store.cardRecords['research-findings.md']!.error).toBe('missing');
  });

  it('requires exact optional-absence identity and never discards accepted closed content',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors});
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name,`${name} accepted`));
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A);
    vi.mocked(getCardRecord).mockImplementation(async(_cardId,name)=>{throw new ApiError(404,'missing',{error:'Card record not found',cardId:'card-b',name,extra:true});});
    store.onInvalidate({resource:'cards',scope:'record',card_id:A,record_name:'research-findings.md'}); await Promise.resolve(); await Promise.resolve();
    expect(store.cardRecords['research-findings.md']!.accepted).toMatchObject({kind:'content',content:'research-findings.md accepted'});
    expect(store.cardRecords['research-findings.md']!.staleReason).toBe('refresh-failed');
    vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>{throw new ApiError(404,'missing',{error:'Card record not found',cardId,name});});
    await store.retryRecord('research-findings.md');
    expect(store.cardRecords['research-findings.md']!.accepted).toMatchObject({kind:'content',content:'research-findings.md accepted'});
    expect(store.cardRecords['research-findings.md']!.staleReason).toBe('refresh-failed');
  });

  it('refreshes only an accepted exact record and tears owners down on a missing selected card',async()=>{
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView(A)}); vi.mocked(listCardRecords).mockResolvedValue({card_id:A,records:descriptors}); vi.mocked(getCardRecord).mockImplementation(async(cardId,name)=>content(cardId,name));
    const store=useCardStore(); await store.fetchCardDetail(A); await store.loadCardRecords(A); vi.mocked(getCardRecord).mockClear();
    store.onInvalidate({resource:'cards',scope:'record',card_id:A,record_name:'decision.md'}); await Promise.resolve(); await Promise.resolve();
    expect(getCardRecord).toHaveBeenCalledTimes(1); expect(getCardRecord).toHaveBeenCalledWith(A,'decision.md',expect.any(AbortSignal));
    vi.mocked(getCard).mockRejectedValueOnce(new ApiError(404,'missing',{error:'Card not found',cardId:A})); await store.refreshCardDetail('invalidated');
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
});
