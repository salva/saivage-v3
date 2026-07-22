import { createPinia,setActivePinia } from 'pinia';
import { beforeEach,describe,expect,it,vi } from 'vitest';

vi.mock('../api/client',()=>({
  getCardChildren:vi.fn(),getCard:vi.fn(),listCardHistory:vi.fn(),getCardHistoryEntry:vi.fn(),getCardDiff:vi.fn(),getFileContent:vi.fn(),
  ApiError:class extends Error{body={};constructor(public status:number,text:string){super(text);}get isUnauthorized(){return this.status===401;}get isNotFound(){return this.status===404;}},
}));

import { ApiError,getCard,getCardChildren,getFileContent } from '../api/client';
import { useCardStore } from '../stores/cards';
import { cardView } from './card-view-fixtures';

const A='card-a';
const descriptors=[
  {name:'brief.md',format:'markdown' as const,schema:'brief.v1',writers:['analyst'],bootstrap:true},
  {name:'research-findings.md',format:'markdown' as const,schema:'research.v1',writers:['researcher'],bootstrap:false},
  {name:'test-report.md',format:'markdown' as const,schema:'test.v1',writers:['tester'],bootstrap:false},
  {name:'decision.md',format:'markdown' as const,schema:'decision.v1',writers:['reviewer'],bootstrap:false},
];

describe('CardStore dynamic records',()=>{
  beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});

  it('keeps hierarchy slices independent and derives committed-order paths',async()=>{
    vi.mocked(getCardChildren).mockResolvedValue({card:cardView('project',{children:['card-b',A]}),children:[cardView('card-b'),cardView(A)]});
    const store=useCardStore();await store.ensureRoot();
    expect(store.hierarchyPathFor('card-b')).toBe('1');expect(store.hierarchyPathFor(A)).toBe('2');
  });

  it('loads more than three configured records and accepts optional 404 as empty',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A),records:descriptors});
    vi.mocked(getFileContent).mockImplementation(async(path)=>{if(path.includes('research-findings.md'))throw new ApiError(404,'missing',{});return {path,size:1,contentType:'text/markdown',content:path,redacted:false,sensitivity:'normal',version:2,modifiedAt:'2026-07-22T00:00:00.000Z'};});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);
    expect(Object.keys(store.cardRecords)).toEqual(descriptors.map((record)=>record.name));
    expect(store.cardRecords['research-findings.md']!.accepted).toEqual({kind:'empty'});
    expect(store.cardRecords['decision.md']!.accepted).toMatchObject({kind:'content',version:2});
  });

  it('refreshes only the exact accepted dynamic invalidation name',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A),records:descriptors});
    vi.mocked(getFileContent).mockResolvedValue({path:'',size:1,contentType:'text/markdown',content:'ok',redacted:false,sensitivity:'normal'});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);vi.mocked(getFileContent).mockClear();
    store.onInvalidate({resource:'cards',scope:'record',card_id:A,record_name:'decision.md'});await Promise.resolve();await Promise.resolve();
    expect(getFileContent).toHaveBeenCalledTimes(1);expect(vi.mocked(getFileContent).mock.calls[0]![0]).toContain('decision.md');
  });

  it('tears down dynamic record owners when selected detail becomes absent',async()=>{
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView(A),records:descriptors});vi.mocked(getFileContent).mockResolvedValue({path:'',size:1,contentType:'text/markdown',content:'ok',redacted:false,sensitivity:'normal'});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);vi.mocked(getCard).mockRejectedValueOnce(new ApiError(404,'missing',{}));await store.refreshCardDetail('invalidated');
    expect(store.selectedDetail).toBeNull();expect(store.cardRecords).toEqual({});
  });

  it('switches ordered record sets by card type and preserves accepted records across same-card detail refresh',async()=>{
    const codeDescriptors=descriptors.slice(0,2);
    const researchDescriptors=[descriptors[0]!,descriptors[1]!,descriptors[3]!];
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView(A,{type:'code'}),records:codeDescriptors});
    vi.mocked(getFileContent).mockResolvedValue({path:'',size:1,contentType:'text/markdown',content:'accepted',redacted:false,sensitivity:'normal',version:1,modifiedAt:'2026-07-22T00:00:00.000Z'});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);
    const accepted=store.cardRecords['brief.md']!.accepted;
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView(A,{type:'code',title:'refreshed'}),records:codeDescriptors});
    await store.refreshCardDetail('invalidated');
    expect(store.cardRecords['brief.md']!.accepted).toBe(accepted);
    vi.mocked(getCard).mockResolvedValueOnce({card:cardView('card-b',{type:'research'}),records:researchDescriptors});
    await store.fetchCardDetail('card-b');
    expect(Object.keys(store.cardRecords)).toEqual(['brief.md','research-findings.md','decision.md']);
  });

  it('treats bootstrap initial 404 as error and retains accepted optional content on refresh 404',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A),records:descriptors});
    vi.mocked(getFileContent).mockImplementation(async(path)=>{if(path.includes('brief.md'))throw new ApiError(404,'missing',{});return{path,size:1,contentType:'text/markdown',content:'accepted',redacted:false,sensitivity:'normal',version:1,modifiedAt:null};});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);
    expect(store.cardRecords['brief.md']!.error).toContain('missing');
    expect(store.cardRecords['decision.md']!.accepted).toMatchObject({kind:'content',content:'accepted'});
    vi.mocked(getFileContent).mockRejectedValueOnce(new ApiError(404,'gone',{}));await store.refreshRecord('decision.md','invalidated');
    expect(store.cardRecords['decision.md']!.accepted).toMatchObject({kind:'content',content:'accepted'});
    expect(store.cardRecords['decision.md']!.staleReason).toBe('refresh-failed');
  });

  it('aborts and sequence-supersedes old selected-card record owners',async()=>{
    vi.mocked(getCard).mockImplementation(async(id)=>({card:cardView(id),records:descriptors.slice(0,1)}));
    let release!:()=>void;const old=new Promise<void>((resolve)=>{release=resolve;});
    vi.mocked(getFileContent).mockImplementationOnce(async()=>{await old;return{path:'old',size:1,contentType:'text/markdown',content:'old',redacted:false,sensitivity:'normal'};}).mockResolvedValue({path:'new',size:1,contentType:'text/markdown',content:'new',redacted:false,sensitivity:'normal'});
    const store=useCardStore();await store.fetchCardDetail(A);const oldLoad=store.loadCardRecords(A);await store.fetchCardDetail('card-b');await store.loadCardRecords('card-b');release();await oldLoad;
    expect(store.selectedCardId).toBe('card-b');expect(store.cardRecords['brief.md']!.accepted).toMatchObject({kind:'content',content:'new'});
  });

  it('reconnect refreshes every accepted dynamic record except retained refresh failures',async()=>{
    vi.mocked(getCard).mockResolvedValue({card:cardView(A),records:descriptors});vi.mocked(getFileContent).mockResolvedValue({path:'',size:1,contentType:'text/markdown',content:'ok',redacted:false,sensitivity:'normal'});
    const store=useCardStore();await store.fetchCardDetail(A);await store.loadCardRecords(A);vi.mocked(getFileContent).mockRejectedValueOnce(new Error('refresh failed'));await store.refreshRecord('decision.md','invalidated');vi.mocked(getFileContent).mockClear();store.onReconnect();await Promise.resolve();await Promise.resolve();
    expect(vi.mocked(getFileContent).mock.calls.some(([path])=>path.includes('decision.md'))).toBe(false);
    expect(vi.mocked(getFileContent).mock.calls.map(([path])=>path)).toHaveLength(3);
  });
});
