import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { CardService } from '../../src/cards/card-service.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { defaultParentForCreate } from '../../src/tools/analyst-tool-helpers.js';
import { propagateAnalystRecordEdit } from '../../src/runtime/changed-propagation.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('capability-based configurable card-type semantics',()=>{
  it('uses renamed child-capable workflows for omitted parents and record-edit notifications',()=>{
    const root=mkdtempSync(join(tmpdir(),'custom-card-semantics-'));roots.push(root);initProjectTree(root);
    const config:SaivageConfig=structuredClone(TEST_SAIVAGE_CONFIG);
    const project=structuredClone(config.card_types.project!);project.permitted_child_types=['initiative'];
    const initiative=structuredClone(config.card_types.goal!);initiative.permitted_child_types=['task'];
    const task=structuredClone(config.card_types.code!);task.permitted_child_types=[];
    config.card_types={project,initiative,task};
    const cards=new CardService(root,compileProjectWorkflows(config));
    const plan=cards.create({type:'initiative',parent:'project',title:'Plan',bootstrap_content:'plan',tags:[],priority:0,urgency:'normal',created_by:'analyst',depends_on:[],related:[]});
    const work=cards.create({type:'task',parent:plan.id,title:'Work',bootstrap_content:'work',tags:[],priority:0,urgency:'normal',created_by:'analyst',depends_on:[],related:[]});
    expect(defaultParentForCreate(cards,'initiative')).toBe('project');
    expect(defaultParentForCreate(cards,'task')).toBe(plan.id);
    const notify=jest.fn((_cardId:string)=>({ok:true as const,notificationId:'notification'}));
    propagateAnalystRecordEdit(cards,work.id,{kind:'analyst_edit',summary:'updated'},notify);
    expect(notify.mock.calls.map(([cardId])=>cardId)).toEqual([plan.id,'project']);
    expect(notify.mock.calls.map(([cardId])=>cardId)).not.toContain(work.id);
  });
});
