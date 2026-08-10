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

  it('publishes one deeply immutable state table in exact source order',()=>{
    const compiled = compileProjectWorkflows(source());
    expect([...compiled.cardTypes.keys()]).toEqual([
      'project','goal','architecture','code','test','doc','data','research','ops',
    ]);
    const goal = compiled.cardTypes.get('goal')!;
    expect([...goal.states.keys()]).toEqual([
      'lifecycle:ready',
      'entry:BACKLOG',
      'entry:CHANGED',
      'entry:BLOCKED',
      'entry:STOPPED',
      'node:plan',
      'node:review',
      'node:recover',
      'terminal:DONE',
      'terminal:BLOCKED',
      'terminal:FAILED',
    ]);
    expect([...goal.states.get('lifecycle:ready')!.on.keys()]).toEqual([
      'activate:BACKLOG',
      'activate:CHANGED',
      'activate:BLOCKED',
      'activate:STOPPED',
    ]);
    const plan = goal.states.get('node:plan')!;
    expect(plan.kind).toBe('node');
    if(plan.kind!=='node') throw new Error('missing plan node');
    expect([...plan.on.keys()]).toEqual([
      'result:complete_direct',
      'result:admit_review',
      'result:blocked',
      'result:failed',
      'execution:failed',
      'execution:blocked',
    ]);
    expect(plan.agent.name).toBe('planner');
    expect([...plan.childCreationTypes]).toContain('code');
    expect(goal.records.get('brief.md')!.bootstrap).toBe(true);
    const activation = goal.states.get('lifecycle:ready')!.on.get('activate:BACKLOG')!;
    expect(activation.semantic).toEqual({kind:'activation'});
    expect(goal.states.get(activation.targetStateId)).toMatchObject({
      kind:'entry',entry:'BACKLOG',
    });
    const entryRoute = goal.states.get(activation.targetStateId)!.on.get('entry:route')!;
    expect(entryRoute.semantic).toEqual({kind:'entry-route',promptId:null});
    expect(goal.states.get(entryRoute.targetStateId)).toBe(plan);
    const admitReview = plan.on.get('result:admit_review')!;
    expect(admitReview.semantic).toEqual({
      kind:'configured-outcome',
      outcome:'admit_review',
      promptId:'plan-to-review',
      terminalBehavior:null,
    });
    expect(goal.states.get(admitReview.targetStateId)).toBe(goal.states.get('node:review'));
    const complete = plan.on.get('result:complete_direct')!;
    expect(goal.states.get(complete.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'DONE',isTerminal:true,isParked:false,
    });
    if (complete.semantic.kind !== 'configured-outcome' || !complete.semantic.terminalBehavior)
      throw new Error('missing configured terminal behavior');
    expect(complete.semantic.terminalBehavior.promotion).toEqual({kind:'current'});
    expect(complete.semantic.terminalBehavior.exportRecords.map((record)=>record.name)).toEqual([
      'status.md',
    ]);
    expect(Object.isFrozen(complete.semantic.terminalBehavior)).toBe(true);
    expect(Object.isFrozen(complete.semantic.terminalBehavior.promotion)).toBe(true);
    expect(Object.isFrozen(complete.semantic.terminalBehavior.exportRecords)).toBe(true);
    const runtimeFailed = plan.on.get('execution:failed')!;
    expect(runtimeFailed.semantic).toEqual({kind:'runtime-terminal',cause:'failed'});
    expect(goal.states.get(runtimeFailed.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'FAILED',
    });

    const review = goal.states.get('node:review')!;
    if (review.kind !== 'node' || !review.descendantContext)
      throw new Error('missing review node descendant context');
    expect(Object.isFrozen(review.requirements)).toBe(true);
    expect(Object.isFrozen(review.descendantContext)).toBe(true);
    expect(Object.isFrozen(review.descendantContext.records)).toBe(true);
    expect(Object.isFrozen(plan.agent.tools)).toBe(true);
    expect(Object.isFrozen(plan.agent.model)).toBe(true);
    expect(Object.isFrozen(plan.agent.model.candidates)).toBe(true);

    for (const state of goal.states.values()) {
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.on)).toBe(true);
      if (state.kind === 'terminal') {
        expect(state.on.size).toBe(0);
        expect(state.isTerminal).toBe(true);
        expect(state.isParked).toBe(false);
      }
      for (const transition of state.on.values()) {
        expect(Object.keys(transition)).toEqual(['targetStateId','reenter','semantic']);
        expect(Object.isFrozen(transition)).toBe(true);
        expect(Object.isFrozen(transition.semantic)).toBe(true);
        if (transition.semantic.kind === 'activation') {
          expect(Object.keys(transition.semantic)).toEqual(['kind']);
        } else if (transition.semantic.kind === 'entry-route') {
          expect(Object.keys(transition.semantic)).toEqual(['kind','promptId']);
        } else if (transition.semantic.kind === 'runtime-terminal') {
          expect(Object.keys(transition.semantic)).toEqual(['kind','cause']);
        } else {
          expect(Object.keys(transition.semantic)).toEqual([
            'kind','outcome','promptId','terminalBehavior',
          ]);
        }
        expect(goal.states.has(transition.targetStateId)).toBe(true);
      }
    }
    expect(Object.isFrozen(goal.states)).toBe(true);
    expect(Object.isFrozen(goal.processPrompts)).toBe(true);
    expect((goal.states as Map<unknown,unknown>).set).toBeUndefined();
    expect((plan.on as Map<unknown,unknown>).set).toBeUndefined();
    expect((goal.processPrompts as Map<unknown,unknown>).set).toBeUndefined();
    expect(goal).not.toHaveProperty('definition');
    expect(goal).not.toHaveProperty('nodes');
    expect(goal).not.toHaveProperty('transitionPrompts');
    expect(plan).not.toHaveProperty('edges');
    expect(plan).not.toHaveProperty('outcomes');
    expect(plan).not.toHaveProperty('nodePrompt');
    expect(plan).not.toHaveProperty('correctionPrompt');
    expect((compiled.cardTypes as Map<unknown,unknown>).set).toBeUndefined();
    expect(compiled.cardTypes.get('project')).not.toBe(compiled.cardTypes.get('goal'));
    for(const type of ['architecture','code','test','doc','data','research','ops'] as const)expect(compiled.cardTypes.get(type)?.states.get('node:execute')).toMatchObject({kind:'node',nodeId:'execute'});
    expect(compiled.agents.get('planner')?.tools).toEqual(['create_card','edit_card','cancel_card','activate_card','reorder_child','queue_notification','list_cards','get_card','get_tree','read','write','edit','glob','grep','list_card_history','get_card_history_entry','diff_card','websearch','webfetch']);
    expect(compiled.agents.get('reviewer')?.tools).not.toContain('mcp_tool_call');
    expect(compiled.agents.get('executor')?.tools).toContain('mcp_tool_call');
    expect(compiled.agents.get('analyst')?.tools).toHaveLength(41);
  });

  it('keeps agent, node, and correction prompt snapshots under their compiled owners',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'workflow-prompts-'));
    roots.push(projectRoot);
    const path=join(projectRoot,'.saivage','config','prompts','code','agents');
    mkdirSync(path,{recursive:true});
    writeFileSync(join(path,'executor.md'),'Card override {{contractDescription}}');
    const processPath=join(projectRoot,'.saivage','config','prompts','code','process');
    mkdirSync(processPath,{recursive:true});
    writeFileSync(join(processPath,'execute.md'),'Selected node prompt');
    writeFileSync(join(processPath,'correct-execution-result.md'),'Selected correction prompt');
    const compiled=compileProjectWorkflows(source(),{projectRoot});
    const process=compiled.cardTypes.get('code')!;
    const node=process.states.get('node:execute')!;
    if(node.kind!=='node') throw new Error('missing execute node');
    expect(node.selectedAgentPrompt).toMatchObject({source:'card-specific',text:'Card override {{contractDescription}}'});
    expect(node.promptId).toBe('execute');
    expect(node.correctionPromptId).toBe('correct-execution-result');
    expect(process.processPrompts.get(node.promptId)).toMatchObject({
      source:'override',text:'Selected node prompt',
    });
    expect(process.processPrompts.get(node.correctionPromptId)).toMatchObject({
      source:'override',text:'Selected correction prompt',
    });
    expect(Object.isFrozen(process.processPrompts.get(node.promptId))).toBe(true);
    expect(Object.isFrozen(process.processPrompts.get(node.correctionPromptId))).toBe(true);
    expect(node).not.toHaveProperty('nodePrompt');
    expect(node).not.toHaveProperty('correctionPrompt');
    writeFileSync(join(path,'executor.md'),'changed after compile');
    writeFileSync(join(processPath,'execute.md'),'changed node after compile');
    writeFileSync(join(processPath,'correct-execution-result.md'),'changed correction after compile');
    expect(node.selectedAgentPrompt.text).toBe('Card override {{contractDescription}}');
    expect(process.processPrompts.get(node.promptId)!.text).toBe('Selected node prompt');
    expect(process.processPrompts.get(node.correctionPromptId)!.text).toBe(
      'Selected correction prompt',
    );
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
    const process=compileProjectWorkflows(value).cardTypes.get('code')!;
    const verify=process.states.get('node:verify')!;
    if(verify.kind!=='node') throw new Error('missing verify node');
    const done=verify.on.get('result:done')!;
    expect(done.semantic).toMatchObject({
      kind:'configured-outcome',
      terminalBehavior:{promotion:{kind:'latest-node',nodeId:'execute'}},
    });
    expect(process.states.get(done.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'DONE',
    });
  });

  it('marks configured same-node outcomes as semantic reentry without another destination locator',()=>{
    const value=source();value.card_types.code!.workflow.nodes.execute!.edges.retry={target:{node:'execute'},prompt:'execute'};
    const process=compileProjectWorkflows(value).cardTypes.get('code')!;const node=process.states.get('node:execute')!;if(node.kind!=='node')throw new Error('missing execute node');
    const route=node.on.get('result:retry')!;
    expect(route).toEqual({
      targetStateId:'node:execute',
      reenter:true,
      semantic:{kind:'configured-outcome',outcome:'retry',promptId:'execute',terminalBehavior:null},
    });
    expect(process.states.get(route.targetStateId)).toBe(node);
    expect(Object.keys(route.semantic)).toEqual([
      'kind','outcome','promptId','terminalBehavior',
    ]);
  });
});
