import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { cardRecordRoot, cardRecordsRoot, cardRecordVersionIndexFile, cardVersionIndexFile } from '../../src/persistence/layout.js';
import type { CanonicalReadInstrumentation } from '../../src/persistence/growing-file.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testRecordDefinition, testRecordDefinitions } from '../helpers/record-definitions.js';

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
const input=(parent:string,title:string,type:'goal'|'code'='goal')=>({type,parent,title,bootstrap_content:`${title} token=secret`,tags:[],priority:0,urgency:'normal' as const,created_by:'analyst' as const,depends_on:[],related:[]});
const paths=()=>{const value:string[]=[];const instrumentation:CanonicalReadInstrumentation={onRead:(path)=>value.push(path)};return{value,instrumentation};};

describe('exact Card operator resources',()=>{
  it('projects one ordered active hierarchy slice without child links or descendant reads',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);
    const parent=cards.create(input('project','Parent'));const grandchild=cards.create(input(parent.id,'Grandchild','code'));
    const removed=cards.create(input('project','Removed'));const removedDescendant=cards.create(input(removed.id,'Removed descendant','code'));
    cards.deleteSubtrees([removed.id],()=>true);writeFileSync(cardVersionIndexFile(root,removedDescendant.id),'{descendant-must-not-be-read}\n');
    const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});const read=paths();const response=model.getChildren('project',read.instrumentation);
    expect(response.body).toEqual({parent:{id:'project',title:expect.any(String),type:'project',status:'backlog',permitted_child_types:['goal','architecture','code','test','doc','data','research','ops']},children:[{id:parent.id,title:'Parent',type:'goal',status:'backlog',permitted_child_types:['goal','architecture','code','test','doc','data','research','ops']}]});
    expect(Object.keys((response.body as {children:object[]}).children[0]!)).toEqual(['id','title','type','status','permitted_child_types']);
    expect(read.value).toContain(cardVersionIndexFile(root,'project')); expect(read.value).toContain(cardVersionIndexFile(root,parent.id)); expect(read.value).toContain(cardVersionIndexFile(root,removed.id));
    expect(read.value).not.toContain(cardVersionIndexFile(root,grandchild.id));expect(read.value).not.toContain(cardVersionIndexFile(root,removedDescendant.id));
  });

  it('projects empty compiled child policy and fails fast when a card workflow is missing',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);
    const leaf=cards.create(input('project','Leaf','code'));const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    expect(model.getChildren(leaf.id).body).toMatchObject({parent:{id:leaf.id,permitted_child_types:[]}});
    const missing={getCardChildren:()=>({kind:'found',value:{parent:cards.read(leaf.id),activeChildren:[]}}),workflows:{cardTypes:new Map()}};
    expect(()=>new CardsReadModelService(root,missing as never,{getRuntimeState:()=>null}).getChildren(leaf.id)).toThrow("No compiled workflow for card type 'code'.");
  });

  it('separates detail, definitions, and one latest closed record read',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));
    const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    const detailRead=paths();const detail=model.getCard(card.id,detailRead.instrumentation);
    expect(detail.body).toMatchObject({card:{id:card.id,title:'Target'}});expect(detail.body).not.toHaveProperty('records');
    for(const field of ['children','depends_on','assigned_to','started_at','records','notes','pending_notifications','operator_summary'])expect((detail.body as {card:object}).card).not.toHaveProperty(field);
    expect(detailRead.value.every((path)=>path.endsWith('index.json')||path.endsWith('.json'))).toBe(true);
    const descriptorRead=paths();const descriptors=model.listRecords(card.id,descriptorRead.instrumentation);
    expect(descriptors.body).toMatchObject({card_id:card.id,records:expect.arrayContaining([expect.objectContaining({name:'brief.md',bootstrap:true})])});
    const recordsRoot=cardRecordsRoot(root,card.id);const recordPaths=descriptorRead.value.filter((path)=>path===recordsRoot||path.startsWith(`${recordsRoot}/`));
    expect(recordPaths).toEqual(testRecordDefinitions('goal').flatMap((definition)=>[recordsRoot,cardRecordRoot(root,card.id,definition),cardRecordVersionIndexFile(root,card.id,definition)]));
    const recordRead=paths();const record=model.getRecord(card.id,'brief.md',recordRead.instrumentation);
    expect(record.body).toMatchObject({card_id:card.id,record:{name:'brief.md',head_version:1,state:'closed',accepted:{content:'Target token=[REDACTED]'},effective_content_source:'accepted'}});
    expect(recordRead.value.filter((path)=>path===cardRecordVersionIndexFile(root,card.id,testRecordDefinition('brief.md','goal')))).toHaveLength(1);
  });

  it('distinguishes dynamic and optional absence, malformed names, bootstrap corruption, and inactive cards',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    expect(model.getRecord(card.id,'unknown.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'unknown.md'}});
    expect(()=>model.getRecord(card.id,'UNKNOWN.md')).toThrow();
    expect(model.getRecord(card.id,'status.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'status.md'}});
    cards.openRecord(card.id,'status.md',null);
    expect(model.getRecord(card.id,'status.md')).toMatchObject({body:{card_id:card.id,record:{name:'status.md',head_version:1,state:'open',draft:{content:''},effective_content_source:'draft'}}});
    cards.discardRecord(card.id,'status.md',1,'not needed');
    expect(model.getRecord(card.id,'status.md')).toMatchObject({body:{card_id:card.id,record:{name:'status.md',head_version:2,state:'discarded',accepted:null,draft:null,effective_content_source:null}}});
    unlinkSync(cardRecordVersionIndexFile(root,card.id,testRecordDefinition('brief.md','goal')));
    expect(()=>model.getRecord(card.id,'brief.md')).toThrow();
    cards.deleteSubtrees([card.id],()=>true);
    for(const read of [()=>model.getCard(card.id),()=>model.listRecords(card.id),()=>model.getRecord(card.id,'status.md')]) expect(read()).toEqual({statusCode:404,body:{error:'Card not found',cardId:card.id}});
  });

  it('does not normalize an unexpected record-reader absence',()=>{
    const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>({filename:'brief.md',format:'markdown',schema:'x',bootstrap:true,declared:true})},readCurrentRecord:()=>{throw new AuthoredRecordNotFoundError();}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    expect(()=>model.getRecord('card-a','brief.md')).toThrow(AuthoredRecordNotFoundError);
  });

  it('rethrows publication uncertainty by identity before record absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>({filename:'status.md',format:'markdown',schema:'x',bootstrap:false,declared:true})},readCurrentRecord:()=>{throw fatal;}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });

  it('rethrows publication uncertainty before definition absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>{throw fatal;}}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });

  it('preserves exact historical-unavailability resources across all four Cards branches', () => {
    const historicalError = (reason: 'missing' | 'corrupt' | 'io_error') => Object.assign(new Error('unavailable'), { name: 'AuthoredRecordHistoricalUnavailableError', reason });
    const store = {
      getCardDetail: () => ({ kind: 'found', value: { id: 'card-a', type: 'goal' } }),
      recordReader: { definition: () => ({}) },
      listRecordVersions: () => ({ versions: [{ version: 5 }] }),
      readHistoricalRecord: (_id: string, _name: string, version: number) => { throw historicalError(version === 2 ? 'corrupt' : 'io_error'); },
      readCardVersion: () => ({ kind: 'historical-unavailable', version: 2, reason: 'missing' }),
      diffCardVersions: () => ({ kind: 'historical-unavailable', version: 3, side: 'to', reason: 'corrupt' }),
    };
    const model = new CardsReadModelService('/work', store as never, { getRuntimeState: () => null });

    expect(model.getHistoryEntry('card-a', 2)).toEqual({ statusCode: 404, body: { error: 'historical_version_content_unavailable', resource: 'card', owner_id: 'card-a', version: 2, reason: 'missing' } });
    expect(model.diffCard('card-a', { from: 1, to: 3 })).toEqual({ statusCode: 409, body: { error: 'historical_diff_side_unavailable', resource: 'card', owner_id: 'card-a', version: 3, side: 'to', reason: 'corrupt' } });
    expect(model.getRecordVersion('card-a', 'brief.md', 2)).toEqual({ statusCode: 409, body: { error: 'historical_version_content_unavailable', resource: 'authored_record', owner_id: 'card-a/brief.md', version: 2, reason: 'corrupt' } });
    expect(model.diffRecord('card-a', 'brief.md', { from: 1, to: 5 })).toEqual({ statusCode: 503, body: { error: 'historical_diff_side_unavailable', resource: 'authored_record', owner_id: 'card-a/brief.md', version: 1, side: 'from', reason: 'io_error' } });
  });
});
