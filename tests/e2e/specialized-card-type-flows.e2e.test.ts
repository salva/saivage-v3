import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { publishInitialProjectRuntime } from '../../src/boot/project-runtime-bootstrap.js';
import { CardService } from '../../src/cards/card-service.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { bindRuntimeWorkflows, compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { specializedConfig } from '../fixtures/card-type-sets/specialized.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
const complete=(result:LlmCompleteResult):ProviderTurnCompletion=>({result,provider_exchanges:[]});
const tool=(id:string,name:string,args:object):LlmCompleteResult=>({kind:'tool_calls',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function waitUntil(predicate:()=>boolean){for(let attempt=0;attempt<1000;attempt+=1){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,2));}throw new Error('condition not reached');}

function harness(type:'code'|'architecture',provider:(input:LlmInvocationInput)=>Promise<ProviderTurnCompletion>){
  const root=mkdtempSync(join(tmpdir(),`specialized-${type}-flow-`));roots.push(root);createProjectIdentity(root,`Specialized ${type}`);
  const config=specializedConfig();config.models=structuredClone(TEST_SAIVAGE_CONFIG.models);config.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);config.compaction=structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  const structural=compileProjectWorkflows(config);const workflows=bindRuntimeWorkflows(structural,new ModelRouter(new ProviderRegistry(config)));publishInitialProjectRuntime(root,structural);
  const cards=new CardService(root,structural);const child=cards.create({type,parent:'project',title:`${type} flow`,bootstrap_content:`Exercise ${type}.`,tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
  const registry=new ManagedProcessGroupRegistry();const runtimeProcessRootScope=registry.createContainerScope(registry.rootScope,'runtime-cards');
  const supervisor=new SupervisorRuntimeApi({...testAutonomousCompaction,workflows,projectRoot:root,actorStore:cards,provider:scriptedAdmissionProvider(jest.fn(async(input:LlmInvocationInput)=>provider(input))),conversations:{projectRoot:root},freshness:{runtimeChanged(){},agentMembershipChanged(){}},processRunner:new ProcessRunner(root,registry,testApplicationFatalPort),runtimeProcessRootScope,promptTemplates:createPromptTemplateRegistry(workflows),runtimeGate:new RuntimeGate(),fatalPort:testApplicationFatalPort});
  return{root,cards,child,supervisor};
}

function transitionRows(input:LlmInvocationInput){return input.providerConversation.messages.filter((row)=>row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:'));}

describe('specialized production card-type flows',()=>{
  it('re-enters code green with increasing ordinals and versioned status evidence before refactor completion',async()=>{
    let plannerCalls=0;let executorCalls=0;const ordinals:number[]=[];const transitions:string[]=[];let supervisor!:SupervisorRuntimeApi;let childId='';
    const run=harness('code',async(input)=>{
      if(input.agentName==='planner'){
        plannerCalls+=1;if(plannerCalls===1)return complete(tool('activate','activate_card',{card_id:childId}));if(plannerCalls===2)return complete(tool('parent-write','write',{path:'record:///status.md?card=project',content:'Code child complete.'}));if(plannerCalls===3)return complete(tool('parent-done','emit_result',{outcome:'complete_direct',summary:'Code child accepted.'}));throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      executorCalls+=1;
      if(executorCalls%2===1){const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error('missing active code position');ordinals.push(position.executionOrdinal);transitions.push(...transitionRows(input).slice(-1).map(({content})=>content));}
      const actions=[
        tool('red-write','write',{path:`record:///status.md?card=${childId}`,content:'Defect reproduced.'}),tool('red-result','emit_result',{outcome:'red_confirmed',summary:'Defect reproduced.'}),
        tool('green-one-write','write',{path:`record:///status.md?card=${childId}`,content:'First repair remains red.'}),tool('green-one-result','emit_result',{outcome:'still_red',summary:'First repair remains red.'}),
        tool('green-two-write','write',{path:`record:///status.md?card=${childId}`,content:'Second repair is green.'}),tool('green-two-result','emit_result',{outcome:'green',summary:'Focused check passes.'}),
        tool('refactor-write','write',{path:`record:///status.md?card=${childId}`,content:'No further structural cleanup justified.'}),tool('refactor-result','emit_result',{outcome:'done',summary:'Repair complete.'}),
      ];return complete(actions[executorCalls-1]!);
    });supervisor=run.supervisor;childId=run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');
    expect(ordinals).toEqual([0,1,2,3]);
    expect(transitions.map((text)=>text.match(/^Previous process node: ([^\n]+)/u)?.[1])).toEqual(['red','green','green']);
    expect(transitions[0]).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);expect(transitions[1]).toContain('Accepted outcome: still_red');expect(transitions[1]).toContain('prior repair attempt remains red');
    expect(run.cards.read(run.child.id)!.lifecycle).toMatchObject({status:'done',result:{kind:'workflow-result',agent_name:'executor',node_id:'refactor',outcome:'done',summary:'Repair complete.',records:[{name:'status.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
  });

  it('cycles clean architecture reviews, redrafts after system revision, and promotes the latest draft while exporting final review evidence',async()=>{
    let plannerCalls=0;let executorCalls=0;let reviewerCalls=0;let supervisor!:SupervisorRuntimeApi;let childId='';const nodeStarts:Array<{node:string;input:LlmInvocationInput}>=[];
    const run=harness('architecture',async(input)=>{
      if(input.agentName==='planner'){
        plannerCalls+=1;if(plannerCalls===1)return complete(tool('activate','activate_card',{card_id:childId}));if(plannerCalls===2)return complete(tool('parent-write','write',{path:'record:///status.md?card=project',content:'Architecture child complete.'}));if(plannerCalls===3)return complete(tool('parent-done','emit_result',{outcome:'complete_direct',summary:'Architecture child accepted.'}));throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error('missing architecture position');
      if(input.agentName==='executor'){
        executorCalls+=1;if(executorCalls%2===1)nodeStarts.push({node:position.nodeId,input});const actions=[tool('draft-one-write','write',{path:`record:///status.md?card=${childId}`,content:'Initial architecture draft.'}),tool('draft-one-result','emit_result',{outcome:'ready_for_component_review',summary:'Initial draft ready.'}),tool('draft-two-write','write',{path:`record:///status.md?card=${childId}`,content:'Revised architecture draft cites system findings.'}),tool('draft-two-result','emit_result',{outcome:'ready_for_component_review',summary:'Revised draft ready.'})];return complete(actions[executorCalls-1]!);
      }
      reviewerCalls+=1;if(reviewerCalls%2===1)nodeStarts.push({node:position.nodeId,input});const actions=[
        tool('component-one-write','write',{path:`record:///review.md?card=${childId}`,content:'Component review approved.'}),tool('component-one-result','emit_result',{outcome:'approved',summary:'Component scope approved.'}),
        tool('system-one-write','write',{path:`record:///review.md?card=${childId}`,content:'System revision required.'}),tool('system-one-result','emit_result',{outcome:'revision_required',summary:'Address integration invariant.'}),
        tool('component-two-write','write',{path:`record:///review.md?card=${childId}`,content:'Revised component review approved.'}),tool('component-two-result','emit_result',{outcome:'approved',summary:'Revised component scope approved.'}),
        tool('system-two-write','write',{path:`record:///review.md?card=${childId}`,content:'Final system review approved.'}),tool('system-two-result','emit_result',{outcome:'approved',summary:'System scope approved.'}),
      ];return complete(actions[reviewerCalls-1]!);
    });supervisor=run.supervisor;childId=run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');
    expect(nodeStarts.map(({node})=>node)).toEqual(['draft','component-review','system-review','draft','component-review','system-review']);
    const contexts=nodeStarts.slice(1).map(({input})=>transitionRows(input).at(-1)!.content);expect(contexts.map((text)=>text.match(/^Previous process node: ([^\n]+)/u)?.[1])).toEqual(['draft','component-review','system-review','draft','component-review']);
    for(const {node,input} of nodeStarts.slice(1)){const messages=input.providerConversation.messages;let transitionIndex=-1;for(let index=messages.length-1;index>=0;index-=1){const row=messages[index]!;if(row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:')){transitionIndex=index;break;}}expect(transitionIndex).toBeGreaterThanOrEqual(0);expect(messages[transitionIndex]!.content).toMatch(/record:\/\/\/(status|review)\.md\?card=card-[a-z-]+&v=\d+/u);const destinationPhrase=node==='draft'?'architecture proposal':node==='component-review'?'component-scope architecture review':'system-scope architecture review';expect(messages.slice(transitionIndex+1).some((row)=>row.role==='user'&&row.kind==='text'&&row.content.includes(destinationPhrase))).toBe(true);}
    const reviewUrls=contexts.filter((text)=>text.includes('review.md?')).map((text)=>text.match(/record:\/\/\/review\.md\?card=[^\s]+&v=\d+/u)![0]);expect(new Set(reviewUrls).size).toBe(reviewUrls.length);for(const url of reviewUrls){const version=Number(url.match(/&v=(\d+)$/u)![1]);expect(run.cards.readHistoricalRecord(childId,'review.md',version).versionUrl).toBe(url);}
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'done',result:{kind:'workflow-result',agent_name:'executor',node_id:'draft',outcome:'ready_for_component_review',summary:'Revised draft ready.',records:[{name:'review.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
    expect(run.cards.readCurrentRecord(childId,'review.md').artifact.accepted?.content).toBe('Final system review approved.');
  });
});
