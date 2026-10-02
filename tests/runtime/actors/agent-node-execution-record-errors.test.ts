import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';

type RecordMethods = {
  captureRecordHead(filename: string): unknown;
  discardWrittenRecords(names:Set<string>): void;
  closeAcceptedRecords(node:unknown,candidates:ReadonlyMap<string,unknown>,written:ReadonlySet<string>):unknown;
  validateRecords(node:unknown,baseline:ReadonlyMap<string,number|null>):unknown;
  prepareRecordRequirements(node:unknown):void;
};
const roots: string[] = [];
const gateCases: Array<['clean' | 'continue', 'exists' | 'updated']> = [
  ['clean','exists'], ['clean','updated'], ['continue','exists'], ['continue','updated'],
];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('AgentNodeExecution authored-record absence handling', () => {
  it.each(['project', 'child'] as const)('review freshness observes a %s enqueue/remove round trip with unchanged ordinary history', target => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-review-queue-freshness-'));
    roots.push(root); initProjectTree(root);
    const store = new CardService(root);
    const child = store.create({ type: 'code', parent: 'project', title: 'reviewed child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const runner = new AgentNodeExecution({ cardId: 'project', store } as never, {} as never) as unknown as {
      captureReviewerSnapshot(id: string, records: readonly string[]): unknown;
      reviewerStaleReason(id: string, before: unknown, records: readonly string[]): string | null;
    };
    const id = target === 'project' ? 'project' : child.id;
    const history = store.listCardVersions(id);
    const before = runner.captureReviewerSnapshot('project', ['brief.md']);
    expect(runner.reviewerStaleReason('project', before, ['brief.md'])).toBeNull();
    const notice = { id: '00000000-0000-4000-8000-000000000001', content: 'review context', created_at: '2026-10-02T00:00:00.000Z' };
    store.enqueueNotification(id, notice);
    expect(runner.reviewerStaleReason('project', before, ['brief.md'])).toContain('changed during review');
    const enqueued = runner.captureReviewerSnapshot('project', ['brief.md']);
    store.removeNotifications(id, [notice.id]);
    expect(store.read(id)?.pending_notifications).toEqual([]);
    expect(store.listCardVersions(id)).toEqual(history);
    expect(runner.reviewerStaleReason('project', before, ['brief.md'])).toContain('changed during review');
    expect(runner.reviewerStaleReason('project', enqueued, ['brief.md'])).toContain('changed during review');
  });
  it.each(gateCases)('preserves %s/%s admission and A→B→A mutable freshness on real heads', (mode, gate) => {
    const root=mkdtempSync(join(tmpdir(),'saivage-record-gates-')); roots.push(root); initProjectTree(root);
    const store=new CardService(root); store.acceptRecord('project','status.md','baseline','analyst');
    store.openRecord('project','status.md'); store.editRecord('project','status.md','A');
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const node={requirements:[{mode,gate,definition:{name:'status.md'}}]};
    runner.prepareRecordRequirements(node);
    const baseline=new Map([['status.md',runner.captureRecordHead('status.md') as number]]);
    const initial=runner.validateRecords(node,baseline);
    if(mode==='clean'||gate==='updated') expect(initial).toHaveProperty('violations');
    else expect(initial).toHaveProperty('candidates');
    if(mode==='clean') store.editRecord('project','status.md','A');
    store.editRecord('project','status.md','B'); store.editRecord('project','status.md','A');
    expect(runner.validateRecords(node,baseline)).toHaveProperty('candidates');
    const result=store.readRecordCurrent('project','status.md');
    expect(result).toMatchObject({kind:'found',value:{projection:{accepted:{source_version:1,content:'baseline'},draft:{content:'A'}}}});
    const history=store.readRecordHistory('project','status.md');
    expect(history.kind==='found'&&history.value.catalog.versions.map(({version})=>version)).toEqual([1]);
  });
  it('treats only the concrete type as an absent candidate or cleanup target', () => {
    const absentStore = { readRecordCurrent: jest.fn(() => ({kind:'found',value:{projection:null}})), discardRecord: jest.fn() };
    const absent = new AgentNodeExecution({ cardId: 'project', store: absentStore } as never, {} as never) as unknown as RecordMethods;
    expect(absent.captureRecordHead('status.md')).toBeNull();
    expect(() => absent.discardWrittenRecords(new Set(['review.md']))).not.toThrow();
    expect(absentStore.discardRecord).not.toHaveBeenCalled();

    const hostile = new Error('HOSTILE_AGENT_RECORD_READ');
    const failedStore = { readRecordCurrent: jest.fn(() => { throw hostile; }), discardRecord: jest.fn() };
    const failed = new AgentNodeExecution({ cardId: 'project', store: failedStore } as never, {} as never) as unknown as RecordMethods;
    expect(() => failed.captureRecordHead('status.md')).toThrow(hostile);
    expect(() => failed.discardWrittenRecords(new Set(['review.md']))).toThrow(hostile);
  });

  it('closes updated requirements in declaration order and retains close returns without rereading',()=>{
    const trace:string[]=[];
    const store={readRecordCurrent:jest.fn(),closeRecord:jest.fn((_card:string,name:string)=>{trace.push(name);const sourceVersion=({['alpha.md']:1,['beta.md']:2})[name]!+1;return{revision:sourceVersion,currentUrl:`record:///${name}?card=project`,accepted:{source_version:sourceVersion}};})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({mode:'continue',gate:'updated',definition:{name}}));
    const agent={name:'worker',recordWrites:requirements.map(({definition})=>({source:definition.name,matcher:new RegExp(`^${definition.name.replace('.', '\\.')}$`)}))};
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{currentUrl:`record:///${definition.name}?card=project`,revision:index+1,state:'open',draft:{content:'accepted'}}]));
    expect(runner.closeAcceptedRecords({nodeId:'work',agent,requirements},candidates,new Set())).toEqual([
      {name:'alpha.md',url:'record:///alpha.md?card=project&v=2',version:2},
      {name:'beta.md',url:'record:///beta.md?card=project&v=3',version:3},
    ]);
    expect(trace).toEqual(['alpha.md','beta.md']);
    expect(store.readRecordCurrent).not.toHaveBeenCalled();
  });

  it('stops on the first outcome-unknown close and never reads or closes a later requirement',()=>{
    const failure=new PublicationOutcomeUnknownError();
    const store={readRecordCurrent:jest.fn(),closeRecord:jest.fn((_card:string,name:string)=>{if(name==='alpha.md')throw failure;throw new Error('LATER_CLOSE_REACHED');})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({mode:'continue',gate:'updated',definition:{name}}));
    const agent={name:'worker',recordWrites:requirements.map(({definition})=>({source:definition.name,matcher:new RegExp(`^${definition.name.replace('.', '\\.')}$`)}))};
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{currentUrl:`record:///${definition.name}?card=project`,revision:index+1,state:'open',draft:{content:'accepted'}}]));
    expect(()=>runner.closeAcceptedRecords({nodeId:'work',agent,requirements},candidates,new Set())).toThrow(failure);
    expect(store.closeRecord).toHaveBeenCalledTimes(1);
    expect(store.readRecordCurrent).not.toHaveBeenCalled();
  });

  it('applies exists and updated gates against only non-empty effective content and numeric entry heads', () => {
    const projections = new Map([
      ['closed.md', { revision: 4, currentUrl: 'record:///closed.md?card=project', state: 'closed', accepted: { content: 'accepted' }, draft: null }],
      ['open.md', { revision: 6, currentUrl: 'record:///open.md?card=project', state: 'open', accepted: { content: 'old' }, draft: { content: 'new' } }],
      ['empty.md', { revision: 3, currentUrl: 'record:///empty.md?card=project', state: 'open', accepted: { content: 'old' }, draft: { content: '' } }],
    ]);
    const store={readRecordCurrent:jest.fn((_card:string,name:string)=>({kind:'found',value:{projection:projections.get(name)??null}}))};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const node={requirements:[
      {mode:'continue',gate:'exists',definition:{name:'closed.md'}},
      {mode:'continue',gate:'updated',definition:{name:'open.md'}},
      {mode:'continue',gate:'exists',definition:{name:'empty.md'}},
    ]};
    expect(runner.validateRecords(node,new Map([['closed.md',4],['open.md',5],['empty.md',2]]))).toEqual({violations:["Required record 'record:///empty.md?card=project' is missing or empty."]});
  });

  it('prepares only clean requirements by discard then open and captures the post-preparation numeric head', () => {
    const openProjection={revision:2,state:'open',draft:{content:'old'}};
    const discardRecord=jest.fn(()=>({revision:3}));
    const openRecord=jest.fn(()=>({revision:4}));
    const readRecordCurrent=jest.fn()
      .mockReturnValueOnce({kind:'found',value:{projection:openProjection}})
      .mockReturnValue({kind:'found',value:{projection:{revision:4}}});
    const runner=new AgentNodeExecution({cardId:'project',store:{readRecordCurrent,discardRecord,openRecord}} as never,{} as never) as unknown as RecordMethods;
    runner.prepareRecordRequirements({requirements:[
      {mode:'clean',gate:'updated',definition:{name:'clean.md'}},
      {mode:'continue',gate:'exists',definition:{name:'continue.md'}},
    ]});
    expect(readRecordCurrent).toHaveBeenCalledWith('project','clean.md');
    expect(discardRecord).toHaveBeenCalledWith('project','clean.md');
    expect(openRecord).toHaveBeenCalledWith('project','clean.md');
    expect(runner.captureRecordHead('clean.md')).toBe(4);
  });

  it('closes a tool-less continue-exists resumed draft under glob-authorized accepting provenance', () => {
    const closeRecord=jest.fn((_card:string,name:string,writer:string)=>({revision:8,currentUrl:`record:///${name}?card=project`,accepted:{source_version:8,writer_agent:writer}}));
    const runner=new AgentNodeExecution({cardId:'project',store:{closeRecord}} as never,{} as never) as unknown as RecordMethods;
    const requirement={mode:'continue',gate:'exists',definition:{name:'resume.md'}};
    const node={agent:{name:'worker',tools:[],recordWrites:[{source:'resume.md',matcher:/^resume\.md$/u}]},requirements:[requirement]};
    const candidate={revision:7,currentUrl:'record:///resume.md?card=project',state:'open',draft:{content:'resumed'}};
    expect(runner.closeAcceptedRecords(node,new Map([['resume.md',candidate]]),new Set())).toEqual([{name:'resume.md',url:'record:///resume.md?card=project&v=8',version:8}]);
    expect(closeRecord).toHaveBeenCalledWith('project','resume.md','worker');
  });

  it('closes required records first and free records in sorted order, stopping at the first free failure', () => {
    const trace:string[]=[];
    const nextHead=new Map([['required.md',3],['free-a.md',5],['free-b.md',6],['free-c.md',7]]);const closeRecord=jest.fn((_card:string,name:string)=>{trace.push(name);if(name==='free-b.md')throw new Error('FREE_CLOSE_FAILED');const revision=nextHead.get(name)!;return{revision,currentUrl:`record:///${name}?card=project`,accepted:{source_version:revision}};});
    const open=(name:string,head:number)=>({revision:head,currentUrl:`record:///${name}?card=project`,state:'open',draft:{content:name}});
    const values=new Map([['free-a.md',open('free-a.md',4)],['free-b.md',open('free-b.md',5)],['free-c.md',open('free-c.md',6)]]);
    const store={closeRecord,readRecordCurrent:jest.fn((_card:string,name:string)=>({kind:'found',value:{projection:values.get(name)??null}}))};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const node={agent:{name:'worker',recordWrites:[{source:'*.md',matcher:/^[a-z0-9-]*\.md$/u}]},requirements:[{mode:'continue',gate:'exists',definition:{name:'required.md'}}]};
    expect(()=>runner.closeAcceptedRecords(node,new Map([['required.md',open('required.md',2)]]),new Set(['free-c.md','free-b.md','free-a.md']))).toThrow('FREE_CLOSE_FAILED');
    expect(trace).toEqual(['required.md','free-a.md','free-b.md']);
  });
});
