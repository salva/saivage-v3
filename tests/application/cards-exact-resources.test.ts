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
import { testRecordDefinition } from '../helpers/record-definitions.js';

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
    expect(response.body).toEqual({parent:{id:'project',title:expect.any(String),type:'project',status:'backlog'},children:[{id:parent.id,title:'Parent',type:'goal',status:'backlog'}]});
    expect(Object.keys((response.body as {children:object[]}).children[0]!)).toEqual(['id','title','type','status']);
    expect(read.value).toEqual([cardStreamFile(root,'project'),cardStreamFile(root,parent.id),cardStreamFile(root,removed.id)]);
    expect(read.value).not.toContain(cardStreamFile(root,grandchild.id));expect(read.value).not.toContain(cardStreamFile(root,removedDescendant.id));
  });

  it('separates detail, definitions, and one latest closed record read',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));
    const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    const detailRead=paths();const detail=model.getCard(card.id,detailRead.instrumentation);
    expect(detail.body).toMatchObject({card:{id:card.id,title:'Target'}});expect(detail.body).not.toHaveProperty('records');
    for(const field of ['children','depends_on','assigned_to','started_at','records','notes','pending_notifications','operator_summary'])expect((detail.body as {card:object}).card).not.toHaveProperty(field);
    expect(detailRead.value.every((path)=>path.endsWith('card.jsonl'))).toBe(true);
    const descriptorRead=paths();const descriptors=model.listRecords(card.id,descriptorRead.instrumentation);
    expect(descriptors.body).toMatchObject({card_id:card.id,records:expect.arrayContaining([expect.objectContaining({name:'brief.md',bootstrap:true})])});expect(descriptorRead.value.every((path)=>path.endsWith('card.jsonl'))).toBe(true);
    const recordRead=paths();const record=model.getRecord(card.id,'brief.md',recordRead.instrumentation);
    expect(record.body).toMatchObject({card_id:card.id,record:{name:'brief.md',version:1,content:'Target token=[REDACTED]'}});
    expect(recordRead.value.filter((path)=>path===cardRecordStreamFile(root,card.id,testRecordDefinition('brief.md','goal')))).toHaveLength(1);
  });

  it('distinguishes unknown definitions, optional absence/open-only, bootstrap corruption, and inactive cards',()=>{
    const root=mkdtempSync(join(tmpdir(),'saivage-card-api-'));roots.push(root);initProjectTree(root);const cards=new CardService(root);const card=cards.create(input('project','Target'));const model=new CardsReadModelService(root,cards,{getRuntimeState:()=>null});
    expect(model.getRecord(card.id,'unknown.md')).toEqual({statusCode:404,body:{error:'Card record definition not found',cardId:card.id,name:'unknown.md'}});
    expect(model.getRecord(card.id,'status.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'status.md'}});
    cards.openRecord(card.id,'status.md');
    expect(model.getRecord(card.id,'status.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'status.md'}});
    cards.discardRecord(card.id,'status.md',1,'not needed');
    expect(model.getRecord(card.id,'status.md')).toEqual({statusCode:404,body:{error:'Card record not found',cardId:card.id,name:'status.md'}});
    unlinkSync(cardRecordStreamFile(root,card.id,testRecordDefinition('brief.md','goal')));
    expect(()=>model.getRecord(card.id,'brief.md')).toThrow();
    cards.deleteSubtrees([card.id],()=>true);
    for(const read of [()=>model.getCard(card.id),()=>model.listRecords(card.id),()=>model.getRecord(card.id,'status.md')]) expect(read()).toEqual({statusCode:404,body:{error:'Card not found',cardId:card.id}});
  });

  it('does not normalize an unexpected record-reader absence',()=>{
    const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>({filename:'brief.md',format:'markdown',schema:'x',writers:['analyst'],bootstrap:true})},readRecord:()=>{throw new AuthoredRecordNotFoundError();}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    expect(()=>model.getRecord('card-a','brief.md')).toThrow(AuthoredRecordNotFoundError);
  });

  it('rethrows publication uncertainty by identity before record absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>({filename:'status.md',format:'markdown',schema:'x',writers:['planner'],bootstrap:false})},readRecord:()=>{throw fatal;}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });

  it('rethrows publication uncertainty before definition absence classification',()=>{
    const fatal=new PublicationOutcomeUnknownError();const card={id:'card-a',type:'goal'};
    const store={getCardDetail:()=>({kind:'found',value:card}),recordReader:{definition:()=>{throw fatal;}}};
    const model=new CardsReadModelService('/work',store as never,{getRuntimeState:()=>null});
    try{model.getRecord('card-a','status.md');throw new Error('expected publication uncertainty');}catch(error){expect(error).toBe(fatal);}
  });
});
