import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { admitRecordMutation,mutateRecord } from '../../src/application/record-mutation-service.js';
import { cardRecordStreamFile } from '../../src/persistence/layout.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-record-mutation-'));
  roots.push(root);
  initProjectTree(root);
  return { root, cards: new CardService(root) };
}
const dynamicDefinition = (filename: string) => ({ filename, format: 'markdown' as const, schema: 'authored-record.v1', bootstrap: false, declared: false });
const DENIAL_CASES:Array<[string,'active'|'cancelled'|null,'analyst'|'card_agent',string|undefined,boolean,boolean]>=[
  ['card_not_active',null,'analyst',undefined,true,true],
  ['cross_card_scope','active','card_agent','card-a',true,true],
  ['writer_not_authorized','active','analyst',undefined,false,true],
  ['tool_not_authorized','active','analyst',undefined,true,false],
  ['lifecycle_unsupported','cancelled','analyst',undefined,true,true],
];

describe('card-agent record mutation', () => {
  it.each(DENIAL_CASES)('returns %s before definition or record classification', (reason,state,surface,cardId,writerAllowed,toolAllowed) => {
    const {cards}=setup();const reached=cards.read('project')!;const card=state==='cancelled'?{...reached,lifecycle:{status:'cancelled' as const,result:null,error:null,completed_at:null}}:reached;
    const classifyCurrentRecord=jest.fn(()=>{throw new Error('CLASSIFIER_MUST_NOT_RUN');});
    const configured={recordWrites:writerAllowed?[{matcher:/^brief\.md$/u}]:[],tools:toolAllowed?[{name:'write'}]:[]};
    const store={read:jest.fn(()=>state===null?null:card),classifyCurrentRecord,workflows:{analyst:configured,agents:new Map([['planner',configured]])}} as never;
    const result=admitRecordMutation(store,{path:'record:///brief.md?card=project',operation:'write',surface,agentName:surface==='analyst'?'analyst':'planner',...(cardId?{cardId}:{}),requiredTools:['write']});
    expect(result).toMatchObject({kind:'rejected',data:{code:'record_mutation_denied',reason}});expect(classifyCurrentRecord).not.toHaveBeenCalled();
  });

  it('creates and repeatedly edits a glob-authorized free record independently of requirements', () => {
    const { cards } = setup();
    const written = jest.fn();
    const path = 'record:///review-notes-1.md?card=project';
    const first = mutateRecord(cards, { path, operation: 'write', content: 'first', surface: 'card_agent', agentName: 'reviewer', cardId: 'project', requiredTools: ['write'], onRecordWritten: written });
    expect(first).toMatchObject({ kind: 'applied', data: { state: 'open', head_version: 2, current_url: path } });
    const second = mutateRecord(cards, { path, operation: 'edit', oldString: 'first', newString: 'second', surface: 'card_agent', agentName: 'reviewer', cardId: 'project', requiredTools: ['edit'], onRecordWritten: written });
    expect(second).toMatchObject({ kind: 'applied', data: { state: 'open', head_version: 3, current_url: path } });
    const current=cards.readRecordCurrent('project','review-notes-1.md');expect(current.kind==='found'&&current.value.projection?.artifact.draft?.content).toBe('second');
    expect(written).toHaveBeenNthCalledWith(1, 'review-notes-1.md');
    expect(written).toHaveBeenNthCalledWith(2, 'review-notes-1.md');
  });

  it('rejects glob mismatch and historical URLs before any dynamic namespace effect', () => {
    const { root, cards } = setup();
    const deniedName = 'status-notes.md';
    expect(mutateRecord(cards, { path: `record:///${deniedName}?card=project`, operation: 'write', content: 'no', surface: 'card_agent', agentName: 'reviewer', cardId: 'project', requiredTools: ['write'] })).toMatchObject({ kind: 'rejected', data: { code: 'record_mutation_denied', reason: 'writer_not_authorized' } });
    expect(existsSync(cardRecordStreamFile(root, 'project', dynamicDefinition(deniedName)))).toBe(false);

    const historicalName = 'review-history.md';
    expect(() => mutateRecord(cards, { path: `record:///${historicalName}?card=project&v=1`, operation: 'write', content: 'no', surface: 'card_agent', agentName: 'reviewer', cardId: 'project', requiredTools: ['write'] })).toThrow('Historical record URLs cannot be mutated.');
    expect(existsSync(cardRecordStreamFile(root, 'project', dynamicDefinition(historicalName)))).toBe(false);
  });

  it('exposes crash-left open content, conflicts with Analyst mutation, and lets a later authorized activation reuse and close it', () => {
    const { cards } = setup();
    const path='record:///brief.md?card=project';
    expect(mutateRecord(cards,{path,operation:'write',content:'interrupted draft',surface:'card_agent',agentName:'planner',cardId:'project',requiredTools:['write']})).toMatchObject({kind:'applied',data:{state:'open'}});
    const current=cards.readRecordCurrent('project','brief.md');expect(current.kind==='found'&&current.value.projection?.artifact.draft?.content).toBe('interrupted draft');
    expect(mutateRecord(cards,{path,operation:'write',content:'analyst replacement',surface:'analyst',agentName:'analyst',requiredTools:['write']})).toMatchObject({kind:'rejected',data:{code:'record_open_conflict'}});
    const resumed=mutateRecord(cards,{path,operation:'edit',oldString:'interrupted',newString:'resumed',surface:'card_agent',agentName:'planner',cardId:'project',requiredTools:['edit']});
    expect(resumed).toMatchObject({kind:'applied',data:{state:'open'}});
    if(resumed.kind !== 'applied')throw new Error('Expected resumed mutation success.');
    const closed=cards.closeRecord('project','brief.md','planner');
    expect(closed.artifact).toMatchObject({state:'closed',accepted:{content:'resumed draft',writer_agent:'planner'}});
  });
});
