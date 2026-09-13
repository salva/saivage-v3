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
import { bindRuntimeWorkflows, compileProjectWorkflows, describeNodeResultContract } from '../../src/runtime/card-process/card-process-config.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { specializedConfig } from '../helpers/specialized-config.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { readConversation, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardAgentSessionId, parseConversationSessionId } from '../../src/schemas/conversation-session-id.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
const complete=(result:LlmCompleteResult):ProviderTurnCompletion=>({result,provider_exchanges:[]});
const tool=(id:string,name:string,args:object):LlmCompleteResult=>({kind:'tool_calls',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function waitUntil(predicate:()=>boolean){for(let attempt=0;attempt<1000;attempt+=1){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,2));}throw new Error('condition not reached');}

function harness(type:'code'|'architecture'|'data',provider:(input:LlmInvocationInput)=>Promise<ProviderTurnCompletion>,summary?:{calls:LlmInvocationInput[];content:string}){
  const root=mkdtempSync(join(tmpdir(),`specialized-${type}-flow-`));roots.push(root);createProjectIdentity(root,`Specialized ${type}`);
  const config=specializedConfig();config.models=structuredClone(TEST_SAIVAGE_CONFIG.models);config.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);config.compaction=structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  if(summary){const capabilities=config.providers.test?.capabilities;if(!capabilities)throw new Error('test provider capabilities are missing');capabilities.contextWindowTokens=30_000;}
  const structural=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});const providerRegistry=new ProviderRegistry(config);const workflows=bindRuntimeWorkflows(structural,new ModelRouter(providerRegistry),providerRegistry,config.compaction.context_utilization_fraction);publishInitialProjectRuntime(root,structural);
  const cards=new CardService(root,structural);const child=cards.create({type,parent:'project',title:`${type} flow`,bootstrap_content:`Exercise ${type}.`,tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
  const registry=new ManagedProcessGroupRegistry();const runtimeProcessRootScope=registry.createContainerScope(registry.rootScope,'runtime-cards');
  const summaryOverrides=summary?{compactionConfig:{context_utilization_fraction:0.8,trigger_fraction:0.8,tail_fraction:0.25,snap:'compact_straddler' as const},summarizerProvider:{candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest:deterministicSummarySerialization,completeTurn:async(input:LlmInvocationInput)=>{summary.calls.push(input);return complete({kind:'message',content:summary.content});},projectProviderExchanges:jest.fn()}}:{};
  const supervisor=createSupervisorRuntimeApi({...testAutonomousCompaction,...summaryOverrides,workflows,projectRoot:root,actorStore:cards,provider:scriptedAdmissionProvider(jest.fn(async(input:LlmInvocationInput)=>provider(input))),conversations:{projectRoot:root},freshness:{runtimeChanged(){},agentMembershipChanged(){}},processRunner:new ProcessRunner(root,registry,testApplicationFatalPort),runtimeProcessRootScope,promptTemplates:createPromptTemplateRegistry(workflows),runtimeGate:new RuntimeGate(),fatalPort:testApplicationFatalPort});
  return{root,cards,child,supervisor,workflows:structural};
}

function transitionRows(input:LlmInvocationInput){return input.providerConversation.messages.filter((row)=>row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:'));}

describe('specialized production card-type flows',()=>{
  it('re-enters code green with increasing ordinals and versioned status evidence before refactor completion',async()=>{
    let plannerCalls=0;let executorCalls=0;const ordinals:number[]=[];const transitions:string[]=[];let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;let childId='';
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
    let plannerCalls=0;let executorCalls=0;let reviewerCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;let childId='';const nodeStarts:Array<{node:string;input:LlmInvocationInput}>=[];
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
    for(const {node,input} of nodeStarts.slice(1)){const messages=input.providerConversation.messages;let transitionIndex=-1;for(let index=messages.length-1;index>=0;index-=1){const row=messages[index]!;if(row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:')){transitionIndex=index;break;}}expect(transitionIndex).toBeGreaterThanOrEqual(0);expect(messages[transitionIndex]!.content).toMatch(/record:\/\/\/(status|review)\.md\?card=card-[a-z-]+&v=\d+/u);const process=run.workflows.cardTypes.get('architecture')!;const compiledNode=process.states.get(`node:${node}`)!;if(compiledNode.kind!=='node')throw new Error(`missing compiled node ${node}`);const selectedText=process.processPrompts.get(compiledNode.promptId)!.text;expect(messages.filter((row)=>row.kind==='synthetic_context'&&row.origin==='dynamic'&&row.block_identity===`node-activation:${childId}:${node}`&&row.content===`Current workflow node '${node}':\n\n${selectedText}`)).toHaveLength(1);expect(messages.slice(transitionIndex+1).some((row)=>row.content===selectedText)).toBe(false);}
    const reviewUrls=contexts.filter((text)=>text.includes('review.md?')).map((text)=>text.match(/record:\/\/\/review\.md\?card=[^\s]+&v=\d+/u)![0]);expect(new Set(reviewUrls).size).toBe(reviewUrls.length);for(const url of reviewUrls){const version=Number(url.match(/&v=(\d+)$/u)![1]);const record=run.cards.readRecordVersion(childId,'review.md',version);expect(record.kind==='found'&&record.value.projection.versionUrl).toBe(url);}
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'done',result:{kind:'workflow-result',agent_name:'executor',node_id:'draft',outcome:'ready_for_component_review',summary:'Revised draft ready.',records:[{name:'review.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
    expect(run.cards.readRecordCurrent(childId,'review.md')).toMatchObject({kind:'found',value:{projection:{artifact:{accepted:{content:'Final system review approved.'}}}}});
  });

  it('keeps the compiled data node authoritative across compaction and advances schema_ready to validate in one Executor session',async()=>{
    const retainedHistory='Owner constraint remains applicable. The runtime correction remains unresolved. An earlier implementation idea was proposed, not executed or accepted.';
    const summaryCalls:LlmInvocationInput[]=[];const nodeInputs:Array<{node:string;input:LlmInvocationInput}>=[];let schemaCalls=0;let validateCalls=0;let plannerCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;let childId='';let run!:ReturnType<typeof harness>;let schemaRowsBeforeResult:ReturnType<typeof readConversation>['physicalRows']=[];
    run=harness('data',async(input)=>{
      if(input.agentName==='planner'){
        plannerCalls+=1;if(plannerCalls===1)return complete(tool('activate-data','activate_card',{card_id:childId}));if(plannerCalls===2)return complete(tool('parent-status','write',{path:'record:///status.md?card=project',content:'Data validation is blocked after schema admission.'}));if(plannerCalls===3)return complete(tool('parent-blocked','emit_result',{outcome:'blocked',summary:'Data validation requires external input.'}));throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error('missing data position');nodeInputs.push({node:position.nodeId,input});
      if(position.nodeId==='schema'){
        schemaCalls+=1;
        if(schemaCalls===1){const process=run.workflows.cardTypes.get('data')!;const implement=process.states.get('node:implement')!;if(implement.kind!=='node')throw new Error('missing implement node');const oldText=process.processPrompts.get(implement.promptId)!.text;return complete({kind:'message',content:`Current workflow node 'implement':\n\n${oldText}`});}
        if(schemaCalls===2)return complete(tool('schema-status','write',{path:`record:///status.md?card=${childId}`,content:`Draft schema with assumptions and representative evidence. ${'historical filler '.repeat(5000)}`}));
        if(schemaCalls===3){schemaRowsBeforeResult=readConversation(run.root,parseConversationSessionId(input.sessionId)).physicalRows;return complete(tool('schema-ready','emit_result',{outcome:'schema_ready',summary:'Schema contract is ready for validation.'}));}
      }
      if(position.nodeId==='validate'){
        validateCalls+=1;if(validateCalls===1)return complete(tool('validate-status','write',{path:`record:///status.md?card=${childId}`,content:'Validation cannot finish without the external fixture.'}));if(validateCalls===2)return complete(tool('validate-blocked','emit_result',{outcome:'blocked',summary:'External fixture unavailable.'}));
      }
      throw new Error(`Unexpected executor node/call ${position.nodeId}/${position.nodeId==='schema'?schemaCalls:validateCalls}`);
    },{calls:summaryCalls,content:retainedHistory});supervisor=run.supervisor;childId=run.child.id;
    run.cards.enqueueNotification(childId,{id:'owner-data-constraint',content:'Owner constraint: preserve the supplied field names.',created_at:'2026-09-11T00:00:00.000Z',source:'owner'});

    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');
    if(summaryCalls.length===0)throw new Error(`Expected compaction; observed nodes ${nodeInputs.map(({node})=>node).join(',')}, project ${JSON.stringify(run.cards.read('project')!.lifecycle)}, and child ${JSON.stringify(run.cards.read(childId)!.lifecycle)}`);
    expect(new Set(nodeInputs.map(({input})=>input.sessionId))).toEqual(new Set([cardAgentSessionId('executor',childId)]));
    const process=run.workflows.cardTypes.get('data')!;
    const summarizedSource=summaryCalls.flatMap(({providerConversation})=>providerConversation.messages.map(({content})=>content)).join('\n');const schemaForCorrection=process.states.get('node:schema')!;if(schemaForCorrection.kind!=='node')throw new Error('missing schema correction owner');
    expect(summarizedSource).toContain('Owner constraint: preserve the supplied field names.');expect(summarizedSource).toContain(process.processPrompts.get(schemaForCorrection.correctionPromptId)!.text);expect(summarizedSource).toContain("Current workflow node 'implement':");
    for(const {node,input} of nodeInputs){const compiled=process.states.get(`node:${node}`)!;if(compiled.kind!=='node')throw new Error(`missing data node ${node}`);const text=process.processPrompts.get(compiled.promptId)!.text;const prepared=`Current workflow node '${node}':\n\n${text}`;expect(input.providerConversation.messages.filter((row)=>row.kind==='synthetic_context'&&row.origin==='dynamic'&&row.block_identity===`node-activation:${childId}:${node}`&&row.content===prepared)).toHaveLength(1);expect(input.providerConversation.messages.reduce((count,row)=>count+row.content.split(text).length-1,0)).toBe(1);const contract=describeNodeResultContract(process,`node:${node}`);expect(input.systemPrompt.split(contract)).toHaveLength(2);if(!input.preparedContext)throw new Error(`missing prepared context for data node ${node}`);expect(input.preparedContext.dynamicBlocks).toHaveLength(2);}
    const firstValidate=nodeInputs.find(({node})=>node==='validate')!.input;
    expect(firstValidate.providerConversation.messages.filter((row)=>row.kind==='synthetic_context'&&row.origin==='history_summary'&&row.content===`Historical summary:\n${retainedHistory}`)).toHaveLength(1);
    const transition=transitionRows(firstValidate).at(-1)!.content;expect(transition).toContain('Previous process node: schema\nAccepted outcome: schema_ready');expect(transition).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);
    const schemaState=process.states.get('node:schema')!;if(schemaState.kind!=='node')throw new Error('missing schema node');const schemaText=process.processPrompts.get(schemaState.promptId)!.text;const validateState=process.states.get('node:validate')!;if(validateState.kind!=='node')throw new Error('missing validate node');const validateText=process.processPrompts.get(validateState.promptId)!.text;
    expect(schemaRowsBeforeResult.some((row)=>row.content===`Current workflow node 'schema':\n\n${schemaText}`||row.content===schemaText)).toBe(false);
    const finalConversation=readConversation(run.root,cardAgentSessionId('executor',childId));expect(finalConversation.physicalRows.some((row)=>row.content===`Current workflow node 'validate':\n\n${validateText}`||row.content===validateText)).toBe(false);const historicalRows=readHistoricalConversationSegment(run.root,cardAgentSessionId('executor',childId),1).rows;expect(historicalRows.some((row)=>row.role==='assistant'&&row.content.startsWith("Current workflow node 'implement':"))).toBe(true);expect(historicalRows.some((row)=>row.content===`Current workflow node 'schema':\n\n${schemaText}`||row.content===schemaText||row.content===`Current workflow node 'validate':\n\n${validateText}`||row.content===validateText)).toBe(false);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'blocked',result:{kind:'workflow-result',agent_name:'executor',node_id:'validate',outcome:'blocked',records:[{name:'status.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
  });
});
