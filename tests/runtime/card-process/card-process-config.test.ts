import { afterEach,describe,expect,it } from '@jest/globals';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SAIVAGE_CONFIG } from '../../../src/agents/default-workflow-config.js';
import { bindRuntimeWorkflows,cardProcessEntryForStatus,compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { saivageConfigSchema,type SaivageConfig } from '../../../src/schemas/saivage-config.js';
import type { CardStatus } from '../../../src/schemas/index.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';

function source():SaivageConfig{return saivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));}
function failure(change:(value:SaivageConfig)=>void,message:RegExp):void{const value=source();change(value);expect(()=>compileProjectWorkflows(value)).toThrow(message);}
const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('named-agent card-type workflow compilation',()=>{
  it.each([
    ['backlog','BACKLOG'],['running',null],['blocked','BLOCKED'],['changed','CHANGED'],['stopped','STOPPED'],['done',null],['failed',null],['cancelled',null],
  ] satisfies Array<[CardStatus,'BACKLOG'|'CHANGED'|'BLOCKED'|'STOPPED'|null]>)('maps %s to its workflow entry',(status,entry)=>expect(cardProcessEntryForStatus(status)).toBe(entry));

  it('compiles every card type into immutable named-agent, record, child, and terminal contracts',()=>{
    const compiled=compileProjectWorkflows(source());
    expect([...compiled.cardTypes.keys()]).toEqual(['project','goal','architecture','code','test','doc','data','research','ops']);
    const goal=compiled.cardTypes.get('goal')!;
    expect(goal.nodes.get('plan')!.agent.name).toBe('planner');
    expect([...goal.nodes.get('plan')!.childCreationTypes]).toContain('code');
    expect(goal.records.get('brief.md')!.bootstrap).toBe(true);
    expect(goal.nodes.get('plan')!.edges.get('complete_direct')!.terminalRoute).toMatchObject({terminal:'DONE',promotion:{kind:'current'}});
    expect((compiled.cardTypes as Map<unknown,unknown>).set).toBeUndefined();
    expect(compiled.cardTypes.get('project')).not.toBe(compiled.cardTypes.get('goal'));
    for(const type of ['architecture','code','test','doc','data','research','ops'] as const)expect(compiled.cardTypes.get(type)?.nodes.keys().next().value).toBe('execute');
    expect(compiled.agents.get('planner')?.tools).toEqual(['create_card','edit_card','cancel_card','activate_card','reorder_child','queue_notification','list_cards','get_card','get_tree','read','write','edit','glob','grep','list_card_history','get_card_history_entry','diff_card','websearch','webfetch']);
    expect(compiled.agents.get('reviewer')?.tools).not.toContain('mcp_tool_call');
    expect(compiled.agents.get('executor')?.tools).toContain('mcp_tool_call');
    expect(compiled.agents.get('analyst')?.tools).toHaveLength(41);
  });

  it('selects and freezes prompt text during structural compilation before publication',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'workflow-prompts-'));roots.push(projectRoot);const path=join(projectRoot,'.saivage','config','prompts','code','agents');mkdirSync(path,{recursive:true});writeFileSync(join(path,'executor.md'),'Card override {{contractDescription}}');
    const compiled=compileProjectWorkflows(source(),{projectRoot});const node=compiled.cardTypes.get('code')!.nodes.get('execute')!;
    expect(node.selectedAgentPrompt).toMatchObject({source:'card-specific',text:'Card override {{contractDescription}}'});
    writeFileSync(join(path,'executor.md'),'changed after compile');
    expect(node.selectedAgentPrompt.text).toBe('Card override {{contractDescription}}');
  });

  it('binds configured provider candidates once and fails when a required route has none',()=>{
    const valid=source();valid.providers={test:{models:['gpt-5.6']}};const structural=compileProjectWorkflows(valid);const bound=bindRuntimeWorkflows(structural,new ModelRouter(valid,new ProviderRegistry(valid)));
    expect(bound.runtimeBound).toBe(true);expect(bound.candidateChains.get('reviewer')).toEqual([expect.objectContaining({provider:'test',model:'gpt-5.6'})]);
    const unavailable=source();const unbound=compileProjectWorkflows(unavailable);expect(()=>bindRuntimeWorkflows(unbound,new ModelRouter(unavailable,new ProviderRegistry(unavailable)))).toThrow(/no capability-compatible configured provider candidate/);
  });

  it('rejects missing agents, invalid writer capability, invalid child authority, and graph defects',()=>{
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.agent='missing';},/missing agent/);
    failure((value)=>{value.card_types.code!.records['status.md']!.writers=[];},/writer authority/);
    failure((value)=>{value.agents.planner!.can_create_children=false;},/cannot list create_card/);
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.edges={loop:{target:{node:'execute'},prompt:'execute'}};},/no path to a terminal/);
  });

  it('uses intentionally local export and latest-node promotion validation',()=>{
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.edges.done!.target={terminal:'DONE',promote:'current',export_records:['brief.md']};},/without a source-node present or updated requirement/);
    const value=source();
    const code=value.card_types.code!;
    code.workflow.nodes.verify=structuredClone(code.workflow.nodes.execute!);
    code.workflow.nodes.execute!.edges.done={target:{node:'verify'},prompt:'execute'};
    code.workflow.nodes.verify!.edges.done={target:{terminal:'DONE',promote:{latest_node:'execute'},export_records:['status.md']}};
    expect(()=>compileProjectWorkflows(value)).not.toThrow();
  });
});
