import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';
import { cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
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
    cards.deleteSubtrees([removed.id],()=>true);writeFileSync(cardStreamFile(root,removedDescendant.id),'{descendant-must-not-be-read}\n');
    const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});const read=paths();const response=model.getChildren('project',read.instrumentation);
    expect(response.body).toEqual({parent:{id:'project',title:expect.any(String),type:'project',status:'backlog',permitted_child_types:['goal','architecture','code','test','doc','data','research','ops']},children:[{id:parent.id,title:'Parent',type:'goal',status:'backlog',permitted_child_types:['goal','architecture','code','test','doc','data','research','ops']}]});
    expect(Object.keys((response.body as {children:object[]}).children[0]!)).toEqual(['id','title','type','status','permitted_child_types']);
    expect(read.value).toContain(cardStreamFile(root,'project')); expect(read.value).toContain(cardStreamFile(root,parent.id)); expect(read.value).toContain(cardStreamFile(root,removed.id));
    expect(read.value.filter((path)=>path===cardStreamFile(root,'project'))).toHaveLength(1);
    expect(read.value.filter((path)=>path===cardStreamFile(root,parent.id))).toHaveLength(1);
    expect(read.value.filter((path)=>path===cardStreamFile(root,removed.id))).toHaveLength(1);
    expect(read.value).not.toContain(cardStreamFile(root,grandchild.id));expect(read.value).not.toContain(cardStreamFile(root,removedDescendant.id));
  });

  it('proves an exact nested card through membership with one ancestor-chain read and no sibling reads',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-exact-path-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);
    const parent=cards.create(input('project','Parent'));const sibling=cards.create(input('project','Sibling'));const target=cards.create(input(parent.id,'Target','code'));const other=cards.create(input(parent.id,'Other','code'));
    const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});const read=paths();

    expect(model.getCard(target.id,read.instrumentation).body).toMatchObject({card:{id:target.id}});
    expect(read.value).toEqual([cardStreamFile(root,'project'),cardStreamFile(root,parent.id),cardStreamFile(root,target.id)]);
    expect(read.value).not.toContain(cardStreamFile(root,sibling.id));
    expect(read.value).not.toContain(cardStreamFile(root,other.id));
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
    expect(detailRead.value.every((path)=>path.endsWith('card.jsonl'))).toBe(true);
    const descriptorRead=paths();const descriptors=model.listRecords(card.id,descriptorRead.instrumentation);
    expect(descriptors.body).toMatchObject({card_id:card.id,records:expect.arrayContaining([expect.objectContaining({name:'brief.md',bootstrap:true})])});
    const recordPaths=descriptorRead.value.filter((path)=>path.endsWith('.jsonl')&&!path.endsWith('card.jsonl'));
    expect(new Set(recordPaths)).toEqual(new Set(testRecordDefinitions('goal').map((definition)=>cardRecordStreamFile(root,card.id,definition))));
    const recordRead=paths();const record=model.getRecord(card.id,'brief.md',recordRead.instrumentation);
    expect(record.body).toMatchObject({card_id:card.id,record:{name:'brief.md',head_version:1,state:'closed',accepted:{content:'Target token=[REDACTED]'},effective_content_source:'accepted'}});
    expect(recordRead.value.filter((path)=>path===cardRecordStreamFile(root,card.id,testRecordDefinition('brief.md','goal')))).toHaveLength(1);
  });

  it('diffs projected record views without disclosing raw secret changes',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    const secrets=['sentinel-alpha-SEC1','sentinel-bravo-SEC1','sentinel-charlie-SEC1','sentinel-delta-SEC1'];
    cards.openRecord(card.id,'status.md');
    cards.editRecord(card.id,'status.md',`mode=steady\ntoken=${secrets[0]}`);
    cards.editRecord(card.id,'status.md',`mode=steady\ntoken=${secrets[1]}`);
    const draft=model.diffRecord(card.id,'status.md',{from:2,to:3,view:'draft'});
    const effective=model.diffRecord(card.id,'status.md',{from:2,to:3,view:'effective'});
    expect(draft.body).toMatchObject({view:'draft',hunks:[]});
    expect(effective.body).toMatchObject({view:'effective',hunks:[]});

    cards.closeRecord(card.id,'status.md');
    cards.openRecord(card.id,'status.md');
    cards.editRecord(card.id,'status.md',`mode=steady\ntoken=${secrets[2]}`);
    cards.closeRecord(card.id,'status.md');
    const accepted=model.diffRecord(card.id,'status.md',{from:4,to:7,view:'accepted'});
    expect(accepted.body).toMatchObject({view:'accepted',hunks:[]});

    cards.openRecord(card.id,'status.md');
    cards.editRecord(card.id,'status.md',`mode=changed\ntoken=${secrets[3]}`);
    const safeChange=model.diffRecord(card.id,'status.md',{from:6,to:9,view:'effective'});
    expect(safeChange.body).toMatchObject({view:'effective',hunks:[{old_lines:2,new_lines:2,lines:['-mode=steady','-token=[REDACTED]','+mode=changed','+token=[REDACTED]']}]});
    const serialized=JSON.stringify([draft,effective,accepted,safeChange]);
    for(const secret of secrets)expect(serialized).not.toContain(secret);
  });

  it('distinguishes dynamic and optional absence, malformed names, bootstrap corruption, and inactive cards',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    expect(model.getRecord(card.id,'unknown.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'unknown.md'}});
    expect(()=>model.getRecord(card.id,'UNKNOWN.md')).toThrow();
    expect(model.getRecord(card.id,'status.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'status.md'}});
    cards.openRecord(card.id,'status.md');
    expect(model.getRecord(card.id,'status.md')).toMatchObject({body:{card_id:card.id,record:{name:'status.md',head_version:1,state:'open',draft:{content:''},effective_content_source:'draft'}}});
    cards.discardRecord(card.id,'status.md','not needed');
    expect(model.getRecord(card.id,'status.md')).toMatchObject({body:{card_id:card.id,record:{name:'status.md',head_version:2,state:'discarded',accepted:null,draft:null,effective_content_source:null}}});
    unlinkSync(cardRecordStreamFile(root,card.id,testRecordDefinition('brief.md','goal')));
    expect(()=>model.getRecord(card.id,'brief.md')).toThrow();
    cards.deleteSubtrees([card.id],()=>true);
    for(const read of [()=>model.getCard(card.id),()=>model.listRecords(card.id),()=>model.getRecord(card.id,'status.md')]) expect(read()).toEqual({statusCode:404,body:{error:'Card not found',cardId:card.id}});
  });

  it('does not normalize an unexpected record-reader absence',()=>{
    const card={id:'card-a',type:'goal'};
    const store={readRecordCurrent:()=>{throw new AuthoredRecordNotFoundError();}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    expect(()=>model.getRecord('card-a','brief.md')).toThrow(AuthoredRecordNotFoundError);
  });

  it('rethrows publication uncertainty by identity before record absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={readRecordCurrent:()=>{throw fatal;}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });

  it('rethrows publication uncertainty before definition absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={readRecordCurrent:()=>{throw fatal;}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });

  it('propagates complete card-stream failures and typed not-found without availability branches', () => {
    const store = {
      getCardDetail: () => ({ kind: 'found', value: { id: 'card-a', type: 'goal' } }),
      readCardVersion: () => ({ kind: 'version-not-found', version: 2 }),
    };
    const model = new CardsReadModelService('/work', store as never, { getRuntimeState: () => null });
    expect(model.getHistoryEntry('card-a', 2)).toEqual({ statusCode: 404, body: { error: 'historical_version_not_found', resource: 'card', owner_id: 'card-a', version: 2 } });
  });
});
