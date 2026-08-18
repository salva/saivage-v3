import { describe, expect, it, jest } from '@jest/globals';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { AuthoredRecordNotFoundError } from '../../../src/persistence/authored-record-files.js';

type RecordMethods = {
  captureRecordHead(filename: string): unknown;
  discardWrittenRecords(names:Set<string>, reason: string): void;
  closeAcceptedRecords(node:unknown,candidates:ReadonlyMap<string,unknown>,written:ReadonlySet<string>):unknown;
  validateRecords(node:unknown,baseline:ReadonlyMap<string,number|null>):unknown;
  prepareRecordRequirements(node:unknown):void;
};

describe('AgentNodeExecution authored-record absence handling', () => {
  it('treats only the concrete type as an absent candidate or cleanup target', () => {
    const absentStore = { readCurrentRecordOrNull: jest.fn(() => null), readCurrentRecord: jest.fn(() => { throw new AuthoredRecordNotFoundError(); }), discardRecord: jest.fn() };
    const absent = new AgentNodeExecution({ cardId: 'project', store: absentStore } as never, {} as never) as unknown as RecordMethods;
    expect(absent.captureRecordHead('status.md')).toBeNull();
    expect(() => absent.discardWrittenRecords(new Set(['review.md']), 'stale')).toThrow(AuthoredRecordNotFoundError);
    expect(absentStore.discardRecord).not.toHaveBeenCalled();

    const hostile = new Error('HOSTILE_AGENT_RECORD_READ');
    const failedStore = { readCurrentRecordOrNull: jest.fn(() => { throw hostile; }), readCurrentRecord: jest.fn(() => { throw hostile; }), discardRecord: jest.fn() };
    const failed = new AgentNodeExecution({ cardId: 'project', store: failedStore } as never, {} as never) as unknown as RecordMethods;
    expect(() => failed.captureRecordHead('status.md')).toThrow(hostile);
    expect(() => failed.discardWrittenRecords(new Set(['review.md']), 'stale')).toThrow(hostile);
  });

  it('closes updated requirements in declaration order and retains close returns without rereading',()=>{
    const trace:string[]=[];
    const store={readCurrentRecord:jest.fn(),closeRecord:jest.fn((_card:string,name:string)=>{trace.push(name);const sourceVersion=({['alpha.md']:1,['beta.md']:2})[name]!+1;return{headVersion:sourceVersion,currentUrl:`record:///${name}?card=project`,artifact:{accepted:{source_version:sourceVersion}}};})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({mode:'continue',gate:'updated',definition:{name}}));
    const agent={name:'worker',recordWrites:requirements.map(({definition})=>({source:definition.name,matcher:new RegExp(`^${definition.name.replace('.', '\\.')}$`)}))};
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{currentUrl:`record:///${definition.name}?card=project`,headVersion:index+1,artifact:{state:'open',draft:{content:'accepted'}}}]));
    expect(runner.closeAcceptedRecords({nodeId:'work',agent,requirements},candidates,new Set())).toEqual([
      {name:'alpha.md',url:'record:///alpha.md?card=project&v=2',version:2},
      {name:'beta.md',url:'record:///beta.md?card=project&v=3',version:3},
    ]);
    expect(trace).toEqual(['alpha.md','beta.md']);
    expect(store.readCurrentRecord).not.toHaveBeenCalled();
  });

  it('stops on the first outcome-unknown close and never reads or closes a later requirement',()=>{
    const failure=new PublicationOutcomeUnknownError();
    const store={readCurrentRecord:jest.fn(),closeRecord:jest.fn((_card:string,name:string)=>{if(name==='alpha.md')throw failure;throw new Error('LATER_CLOSE_REACHED');})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({mode:'continue',gate:'updated',definition:{name}}));
    const agent={name:'worker',recordWrites:requirements.map(({definition})=>({source:definition.name,matcher:new RegExp(`^${definition.name.replace('.', '\\.')}$`)}))};
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{currentUrl:`record:///${definition.name}?card=project`,headVersion:index+1,artifact:{state:'open',draft:{content:'accepted'}}}]));
    expect(()=>runner.closeAcceptedRecords({nodeId:'work',agent,requirements},candidates,new Set())).toThrow(failure);
    expect(store.closeRecord).toHaveBeenCalledTimes(1);
    expect(store.readCurrentRecord).not.toHaveBeenCalled();
  });

  it('applies exists and updated gates against only non-empty effective content and numeric entry heads', () => {
    const projections = new Map([
      ['closed.md', { headVersion: 4, currentUrl: 'record:///closed.md?card=project', artifact: { state: 'closed', accepted: { content: 'accepted' }, draft: null } }],
      ['open.md', { headVersion: 6, currentUrl: 'record:///open.md?card=project', artifact: { state: 'open', accepted: { content: 'old' }, draft: { content: 'new' } } }],
      ['empty.md', { headVersion: 3, currentUrl: 'record:///empty.md?card=project', artifact: { state: 'open', accepted: { content: 'old' }, draft: { content: '' } } }],
    ]);
    const store={readCurrentRecord:jest.fn((_card:string,name:string)=>projections.get(name))};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const node={requirements:[
      {mode:'continue',gate:'exists',definition:{name:'closed.md'}},
      {mode:'continue',gate:'updated',definition:{name:'open.md'}},
      {mode:'continue',gate:'exists',definition:{name:'empty.md'}},
    ]};
    expect(runner.validateRecords(node,new Map([['closed.md',4],['open.md',5],['empty.md',2]]))).toEqual({violations:["Required record 'record:///empty.md?card=project' is missing or empty."]});
  });

  it('prepares only clean requirements by discard then open and captures the post-preparation numeric head', () => {
    const openProjection={headVersion:2,artifact:{state:'open',draft:{content:'old'}}};
    const classifyCurrentRecord=jest.fn((_card:string,name:string)=>name==='clean.md'?{kind:'present',projection:openProjection}:{kind:'present',projection:{headVersion:9,artifact:{state:'closed'}}});
    const discardRecord=jest.fn(()=>({headVersion:3}));
    const openRecord=jest.fn(()=>({headVersion:4}));
    const readCurrentRecordOrNull=jest.fn(()=>({headVersion:4}));
    const runner=new AgentNodeExecution({cardId:'project',store:{classifyCurrentRecord,discardRecord,openRecord,readCurrentRecordOrNull}} as never,{} as never) as unknown as RecordMethods;
    runner.prepareRecordRequirements({requirements:[
      {mode:'clean',gate:'updated',definition:{name:'clean.md'}},
      {mode:'continue',gate:'exists',definition:{name:'continue.md'}},
    ]});
    expect(classifyCurrentRecord).toHaveBeenCalledTimes(1);
    expect(classifyCurrentRecord).toHaveBeenCalledWith('project','clean.md');
    expect(discardRecord).toHaveBeenCalledWith('project','clean.md','clean_node_entry');
    expect(openRecord).toHaveBeenCalledWith('project','clean.md');
    expect(runner.captureRecordHead('clean.md')).toBe(4);
  });

  it('closes a tool-less continue-exists resumed draft under glob-authorized accepting provenance', () => {
    const closeRecord=jest.fn((_card:string,name:string,writer:string)=>({headVersion:8,currentUrl:`record:///${name}?card=project`,artifact:{accepted:{source_version:8,writer_agent:writer}}}));
    const runner=new AgentNodeExecution({cardId:'project',store:{closeRecord}} as never,{} as never) as unknown as RecordMethods;
    const requirement={mode:'continue',gate:'exists',definition:{name:'resume.md'}};
    const node={agent:{name:'worker',tools:[],recordWrites:[{source:'resume.md',matcher:/^resume\.md$/u}]},requirements:[requirement]};
    const candidate={headVersion:7,currentUrl:'record:///resume.md?card=project',artifact:{state:'open',draft:{content:'resumed'}}};
    expect(runner.closeAcceptedRecords(node,new Map([['resume.md',candidate]]),new Set())).toEqual([{name:'resume.md',url:'record:///resume.md?card=project&v=8',version:8}]);
    expect(closeRecord).toHaveBeenCalledWith('project','resume.md','worker');
  });

  it('closes required records first and free records in sorted order, stopping at the first free failure', () => {
    const trace:string[]=[];
    const nextHead=new Map([['required.md',3],['free-a.md',5],['free-b.md',6],['free-c.md',7]]);const closeRecord=jest.fn((_card:string,name:string)=>{trace.push(name);if(name==='free-b.md')throw new Error('FREE_CLOSE_FAILED');const headVersion=nextHead.get(name)!;return{headVersion,currentUrl:`record:///${name}?card=project`,artifact:{accepted:{source_version:headVersion}}};});
    const open=(name:string,head:number)=>({headVersion:head,currentUrl:`record:///${name}?card=project`,artifact:{state:'open',draft:{content:name}}});
    const values=new Map([['free-a.md',open('free-a.md',4)],['free-b.md',open('free-b.md',5)],['free-c.md',open('free-c.md',6)]]);
    const store={closeRecord,readCurrentRecord:jest.fn((_card:string,name:string)=>values.get(name))};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const node={agent:{name:'worker',recordWrites:[{source:'*.md',matcher:/^[a-z0-9-]*\.md$/u}]},requirements:[{mode:'continue',gate:'exists',definition:{name:'required.md'}}]};
    expect(()=>runner.closeAcceptedRecords(node,new Map([['required.md',open('required.md',2)]]),new Set(['free-c.md','free-b.md','free-a.md']))).toThrow('FREE_CLOSE_FAILED');
    expect(trace).toEqual(['required.md','free-a.md','free-b.md']);
  });
});
