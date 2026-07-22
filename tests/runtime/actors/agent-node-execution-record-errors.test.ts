import { describe, expect, it, jest } from '@jest/globals';

import { AgentNodeExecution, RecordAcceptanceOutcomeUnknown } from '../../../src/runtime/actors/agent-node-execution.js';
import { AuthoredRecordNotFoundError } from '../../../src/persistence/authored-record-files.js';

type RecordMethods = {
  captureRecord(filename: string): unknown;
  discardOpenRecord(filename: string, reason: string): void;
  closeAcceptedRecords(node:unknown,candidates:ReadonlyMap<string,unknown>):unknown;
};

describe('AgentNodeExecution authored-record absence handling', () => {
  it('treats only the concrete type as an absent candidate or cleanup target', () => {
    const absentStore = { readRecord: jest.fn(() => { throw new AuthoredRecordNotFoundError(); }), discardRecord: jest.fn() };
    const absent = new AgentNodeExecution({ cardId: 'project', store: absentStore } as never, {} as never) as unknown as RecordMethods;
    expect(absent.captureRecord('status.md')).toBeNull();
    expect(() => absent.discardOpenRecord('review.md', 'stale')).not.toThrow();
    expect(absentStore.discardRecord).not.toHaveBeenCalled();

    const hostile = new Error('HOSTILE_AGENT_RECORD_READ');
    const failedStore = { readRecord: jest.fn(() => { throw hostile; }), discardRecord: jest.fn() };
    const failed = new AgentNodeExecution({ cardId: 'project', store: failedStore } as never, {} as never) as unknown as RecordMethods;
    expect(() => failed.captureRecord('status.md')).toThrow(hostile);
    expect(() => failed.discardOpenRecord('review.md', 'stale')).toThrow(hostile);
  });

  it('closes updated requirements in declaration order and retains close returns without rereading',()=>{
    const trace:string[]=[];
    const store={read:jest.fn(()=>({version_seq:7})),readRecord:jest.fn(),closeRecord:jest.fn((_card:string,name:string,version:number)=>{trace.push(name);return{recordUrl:`record:///${name}?card=project&v=${version}`,version};})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({kind:'updated',definition:{name}}));
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{recordUrl:'open',version:index+1,artifact:{state:'open'}}]));
    expect(runner.closeAcceptedRecords({nodeId:'work',agent:{name:'worker'},requirements},candidates)).toEqual([
      {name:'alpha.md',url:'record:///alpha.md?card=project&v=1',version:1},
      {name:'beta.md',url:'record:///beta.md?card=project&v=2',version:2},
    ]);
    expect(trace).toEqual(['alpha.md','beta.md']);
    expect(store.readRecord).not.toHaveBeenCalled();
  });

  it('stops on the first outcome-unknown close and never reads or closes a later requirement',()=>{
    const failure=new Error('append outcome unknown');
    const store={read:jest.fn(()=>({version_seq:7})),readRecord:jest.fn(),closeRecord:jest.fn((_card:string,name:string)=>{if(name==='alpha.md')throw failure;throw new Error('LATER_CLOSE_REACHED');})};
    const runner=new AgentNodeExecution({cardId:'project',store} as never,{} as never) as unknown as RecordMethods;
    const requirements=['alpha.md','beta.md'].map((name)=>({kind:'updated',definition:{name}}));
    const candidates=new Map(requirements.map(({definition},index)=>[definition.name,{recordUrl:'open',version:index+1,artifact:{state:'open'}}]));
    expect(()=>runner.closeAcceptedRecords({nodeId:'work',agent:{name:'worker'},requirements},candidates)).toThrow(RecordAcceptanceOutcomeUnknown);
    expect(store.closeRecord).toHaveBeenCalledTimes(1);
    expect(store.readRecord).not.toHaveBeenCalled();
  });
});
