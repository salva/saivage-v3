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
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
const complete=(result:LlmCompleteResult):ProviderTurnCompletion=>({result,provider_exchanges:[]});
const tool=(id:string,name:string,args:object):LlmCompleteResult=>({kind:'tool_calls',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function waitUntil(predicate:()=>boolean){for(let attempt=0;attempt<1000;attempt+=1){if(predicate())return;await new Promise((resolve)=>setTimeout(resolve,2));}throw new Error('condition not reached');}
function testConfig(){const config=specializedConfig();config.models=structuredClone(TEST_SAIVAGE_CONFIG.models);config.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);config.compaction=structuredClone(TEST_SAIVAGE_CONFIG.compaction);return config;}

function runtimeHarness(root:string,config:SaivageConfig,provider:(input:LlmInvocationInput,signal:AbortSignal)=>Promise<ProviderTurnCompletion>,summary?:{calls:LlmInvocationInput[];content:string}){
  const structural=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});initializeAndValidateCurrentGeneratedState(root,structural);
  const providerRegistry=new ProviderRegistry(config);const workflows=bindRuntimeWorkflows(structural,new ModelRouter(providerRegistry),providerRegistry,config.compaction.context_utilization_fraction);const cards=new CardService(root,structural);
  const registry=new ManagedProcessGroupRegistry();const runtimeProcessRootScope=registry.createContainerScope(registry.rootScope,'runtime-cards');
  const summaryOverrides=summary?{compactionConfig:{context_utilization_fraction:0.8,trigger_fraction:0.8,tail_fraction:0.25,snap:'compact_straddler' as const},summarizerProvider:{candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest:deterministicSummarySerialization,completeTurn:async(input:LlmInvocationInput)=>{summary.calls.push(input);return complete({kind:'message',content:summary.content});},projectProviderExchanges:jest.fn()}}:{};
  const supervisor=createSupervisorRuntimeApi({...testAutonomousCompaction,...summaryOverrides,workflows,projectRoot:root,actorStore:cards,provider:scriptedAdmissionProvider(jest.fn(provider)),conversations:{projectRoot:root},freshness:{runtimeChanged(){},agentMembershipChanged(){}},processRunner:new ProcessRunner(root,registry,testApplicationFatalPort),runtimeProcessRootScope,promptTemplates:createPromptTemplateRegistry(workflows),runtimeGate:new RuntimeGate(),fatalPort:testApplicationFatalPort});
  return{root,cards,supervisor,workflows:structural};
}

function harness(type:'code'|'architecture'|'data'|'test',provider:(input:LlmInvocationInput,signal:AbortSignal)=>Promise<ProviderTurnCompletion>,summary?:{calls:LlmInvocationInput[];content:string}){
  const root=mkdtempSync(join(tmpdir(),`specialized-${type}-flow-`));roots.push(root);createProjectIdentity(root,`Specialized ${type}`);
  const config=testConfig();
  if(summary){const capabilities=config.providers.test?.capabilities;if(!capabilities)throw new Error('test provider capabilities are missing');capabilities.contextWindowTokens=30_000;}
  const structural=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});publishInitialProjectRuntime(root,structural);
  const child=new CardService(root,structural).create({type,parent:'project',title:`${type} flow`,bootstrap_content:`Exercise ${type}.`,tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
  return{...runtimeHarness(root,config,provider,summary),child};
}

function transitionRows(input:LlmInvocationInput){return input.providerConversation.messages.filter((row)=>row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:'));}
function latestToolResult(input:LlmInvocationInput){const row=input.providerConversation.messages.filter(({role})=>role==='tool').at(-1);if(!row)throw new Error('expected a prior tool result');return JSON.parse(row.content) as {success:boolean;data?:{exit_code?:number|null;status?:string}};}
function outcomeEnum(input:LlmInvocationInput){const definition=input.tools.find(({function:{name}})=>name==='emit_result');if(!definition)throw new Error('emit_result is not installed');return ((definition.function.parameters as {properties:{outcome:{enum:string[]}}}).properties.outcome.enum);}
const passingSuite=`${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:assert/strict').equal(2 + 2, 4)")}`;
const addCoverageSuite=`${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 4)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const installFailingSuite=`${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 5)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const repairSuite=`${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').writeFileSync('focused-test.cjs', \"require('node:assert/strict').equal(2 + 2, 4)\\n\")")} && ${JSON.stringify(process.execPath)} focused-test.cjs`;
const verifyInstalledSuite=`${JSON.stringify(process.execPath)} focused-test.cjs`;

describe('specialized production card-type flows',()=>{
  it('accepts a fresh adequately covered passing test baseline through diagnosis and verify-owned completion',async()=>{
    let plannerCalls=0;let executorCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;let childId='';const nodeInputs:Array<{node:string;input:LlmInvocationInput}>=[];
    const run=harness('test',async(input)=>{
      if(input.agentName==='planner'){
        plannerCalls+=1;if(plannerCalls===1)return complete(tool('activate-test','activate_card',{card_id:childId}));if(plannerCalls===2){expect(latestToolResult(input).success).toBe(true);return complete(tool('parent-status','write',{path:'record:///status.md?card=project',content:'Test child completed through verification.'}));}if(plannerCalls===3)return complete(tool('parent-done','emit_result',{outcome:'complete_direct',summary:'Verified test baseline accepted.'}));throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error('missing test position');nodeInputs.push({node:position.nodeId,input});executorCalls+=1;
      const actions=[
        tool('diagnose-suite','run_command',{command:passingSuite}),
        tool('diagnose-status','write',{path:`record:///status.md?card=${childId}`,content:'Target: arithmetic baseline. Command passed. Meaningful accepted-brief coverage is adequate. Classification: coverage_ready. Status: ready for verification.'}),
        tool('diagnose-ready','emit_result',{outcome:'coverage_ready',summary:'Meaningful coverage is adequate and focused tests pass.'}),
        tool('verify-suite','run_command',{command:passingSuite}),
        tool('verify-status','write',{path:`record:///status.md?card=${childId}`,content:'Verification reran the affected deterministic suite successfully and confirmed meaningful, stable, scoped coverage.'}),
        tool('verify-done','emit_result',{outcome:'done',summary:'Affected suite and coverage verified.'}),
      ];
      if(executorCalls===2||executorCalls===5)expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});
      if(position.nodeId==='diagnose')expect(outcomeEnum(input)).toEqual(['coverage_ready','coverage_gap','failing_test','blocked','failed']);
      if(position.nodeId==='verify')expect(outcomeEnum(input)).toEqual(['done','coverage_gap','repair_needed','blocked','failed']);
      return complete(actions[executorCalls-1]!);
    });supervisor=run.supervisor;childId=run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');
    expect(nodeInputs.map(({node})=>node)).toEqual(['diagnose','diagnose','diagnose','verify','verify','verify']);
    const firstVerify=nodeInputs.find(({node})=>node==='verify')!.input;const transition=transitionRows(firstVerify).at(-1)!.content;expect(transition).toContain('Previous process node: diagnose\nAccepted outcome: coverage_ready');expect(transition).toMatch(/record:\/\/\/status\.md\?card=card-[a-z-]+&v=\d+/u);
    const process=run.workflows.cardTypes.get('test')!;const verify=process.states.get('node:verify')!;if(verify.kind!=='node')throw new Error('missing verify node');expect(firstVerify.providerConversation.messages).toContainEqual(expect.objectContaining({kind:'synthetic_context',origin:'dynamic',block_identity:`node-activation:${childId}:verify`,content:`Current workflow node 'verify':\n\n${process.processPrompts.get(verify.promptId)!.text}`}));
    expect(nodeInputs.some(({node})=>node==='add-coverage'||node==='repair')).toBe(false);
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'done',result:{kind:'workflow-result',agent_name:'executor',node_id:'verify',outcome:'done',summary:'Affected suite and coverage verified.',records:[{name:'status.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
    expect(run.cards.read('project')!.lifecycle).toMatchObject({status:'done',result:{outcome:'complete_direct'}});
  });

  it('re-enters a genuinely blocked test from the retained old graph and completes through the new ready edge',async()=>{
    const root=mkdtempSync(join(tmpdir(),'specialized-test-blocked-reentry-'));roots.push(root);createProjectIdentity(root,'Blocked test re-entry');
    const oldConfig=testConfig();delete oldConfig.card_types.test!.workflow.nodes.diagnose!.edges.coverage_ready;
    const oldStructural=compileProjectWorkflows(oldConfig,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});publishInitialProjectRuntime(root,oldStructural);
    const child=new CardService(root,oldStructural).create({type:'test',parent:'project',title:'Blocked test',bootstrap_content:'Confirm the supplied fixture with meaningful focused coverage.',tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
    let oldPlannerCalls=0;let oldExecutorCalls=0;const oldRun=runtimeHarness(root,oldConfig,async(input)=>{
      if(input.agentName==='planner'){oldPlannerCalls+=1;if(oldPlannerCalls===1)return complete(tool('old-activate','activate_card',{card_id:child.id}));if(oldPlannerCalls===2)return complete(tool('old-parent-status','write',{path:'record:///status.md?card=project',content:'Test child is blocked on the unavailable fixture.'}));if(oldPlannerCalls===3)return complete(tool('old-parent-blocked','emit_result',{outcome:'blocked',summary:'Required fixture unavailable.'}));throw new Error(`Unexpected old Planner call ${oldPlannerCalls}`);}
      oldExecutorCalls+=1;if(oldExecutorCalls===1)return complete(tool('old-child-status','write',{path:`record:///status.md?card=${child.id}`,content:'Target identified, but the required fixture is unavailable. Classification: blocked.'}));if(oldExecutorCalls===2)return complete(tool('old-child-blocked','emit_result',{outcome:'blocked',summary:'Required fixture unavailable.'}));throw new Error(`Unexpected old Executor call ${oldExecutorCalls}`);
    });
    expect((await oldRun.supervisor.startProject()).started).toBe(true);await waitUntil(()=>oldRun.supervisor.getStatus().status==='stopped');expect(oldRun.cards.read(child.id)!.lifecycle.status).toBe('blocked');expect(oldRun.cards.read('project')!.lifecycle.status).toBe('blocked');
    const retained=oldRun.cards.readRecordCurrent(child.id,'status.md');if(retained.kind!=='found'||retained.value.projection===null)throw new Error('missing retained blocked evidence');const retainedUrl=retained.value.projection.versionUrl;

    const currentConfig=testConfig();const resolvedInput='The required fixture is now available; rerun diagnosis against it.';let plannerCalls=0;let executorCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;const nodes:string[]=[];let firstExecutorInput:LlmInvocationInput|undefined;
    const resumed=runtimeHarness(root,currentConfig,async(input)=>{
      if(input.agentName==='planner'){plannerCalls+=1;if(plannerCalls===1)return complete(tool('resolved-notification','queue_notification',{card_id:child.id,kind:'resolved_input',body:resolvedInput,urgency:'normal'}));if(plannerCalls===2)return complete(tool('resume-child','activate_card',{card_id:child.id}));if(plannerCalls===3)return complete(tool('resumed-parent-status','write',{path:'record:///status.md?card=project',content:'Previously blocked test is now verified.'}));if(plannerCalls===4)return complete(tool('resumed-parent-done','emit_result',{outcome:'complete_direct',summary:'Resolved test accepted.'}));throw new Error(`Unexpected resumed Planner call ${plannerCalls}`);}
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===child.id)?.processState;if(position?.kind!=='node')throw new Error('missing resumed test position');nodes.push(position.nodeId);executorCalls+=1;if(!firstExecutorInput)firstExecutorInput=input;
      const actions=[tool('resumed-diagnose-suite','run_command',{command:passingSuite}),tool('resumed-diagnose-status','write',{path:`record:///status.md?card=${child.id}`,content:'Resolved fixture is available. Focused suite passes with meaningful adequate coverage. Classification: coverage_ready.'}),tool('resumed-ready','emit_result',{outcome:'coverage_ready',summary:'Resolved input confirms adequate passing coverage.'}),tool('resumed-verify-suite','run_command',{command:passingSuite}),tool('resumed-verify-status','write',{path:`record:///status.md?card=${child.id}`,content:'Verification reran the affected suite and accepted its meaningful coverage.'}),tool('resumed-done','emit_result',{outcome:'done',summary:'Resolved test suite and coverage verified.'})];if(executorCalls===2||executorCalls===5)expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});return complete(actions[executorCalls-1]!);
    });supervisor=resumed.supervisor;
    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');expect(nodes).toEqual(['diagnose','diagnose','diagnose','verify','verify','verify']);expect(firstExecutorInput?.providerConversation.messages.filter((message)=>message.role==='user'&&message.kind==='text'&&message.content===resolvedInput)).toHaveLength(1);
    const retainedVersion=Number(retainedUrl.match(/&v=(\d+)$/u)![1]);expect(resumed.cards.readRecordVersion(child.id,'status.md',retainedVersion)).toMatchObject({kind:'found',value:{projection:{versionUrl:retainedUrl,artifact:{accepted:{content:'Target identified, but the required fixture is unavailable. Classification: blocked.'}}}}});
    expect(resumed.cards.read(child.id)!.lifecycle).toMatchObject({status:'done',result:{node_id:'verify',outcome:'done'}});expect(resumed.cards.read('project')!.lifecycle.status).toBe('done');
  });

  it('re-enters retained STOPPED test state after a real abort-aware Supervisor Stop',async()=>{
    const root=mkdtempSync(join(tmpdir(),'specialized-test-stopped-reentry-'));roots.push(root);createProjectIdentity(root,'Stopped test re-entry');const config=testConfig();const structural=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});publishInitialProjectRuntime(root,structural);const child=new CardService(root,structural).create({type:'test',parent:'project',title:'Stopped test',bootstrap_content:'Verify the already-covered baseline.',tags:[],priority:0,urgency:'normal',created_by:'planner',depends_on:[],related:[]});
    let pendingResolve!:()=>void;const pendingReached=new Promise<void>((resolve)=>{pendingResolve=resolve;});let firstPlannerCalls=0;let firstExecutorCalls=0;
    const first=runtimeHarness(root,config,async(input,signal)=>{if(input.agentName==='planner'){firstPlannerCalls+=1;if(firstPlannerCalls===1)return complete(tool('first-activate','activate_card',{card_id:child.id}));throw new Error(`Unexpected first Planner call ${firstPlannerCalls}`);}firstExecutorCalls+=1;if(firstExecutorCalls===1)return complete(tool('first-suite','run_command',{command:passingSuite}));if(firstExecutorCalls===2){expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});return complete(tool('accepted-before-stop','write',{path:`record:///status.md?card=${child.id}`,content:'Accepted pre-stop evidence: focused suite passed with meaningful coverage.'}));}if(firstExecutorCalls===3)return complete(tool('ready-before-stop','emit_result',{outcome:'coverage_ready',summary:'Pre-stop diagnosis accepted adequate passing coverage.'}));if(firstExecutorCalls===4){pendingResolve();return new Promise<never>((_resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}throw new Error(`Unexpected first Executor call ${firstExecutorCalls}`);});
    expect((await first.supervisor.startProject()).started).toBe(true);await pendingReached;const retained=first.cards.readRecordCurrent(child.id,'status.md');if(retained.kind!=='found'||retained.value.projection===null)throw new Error('missing accepted pre-stop evidence');const retainedUrl=retained.value.projection.versionUrl;await expect(first.supervisor.stopProject()).resolves.toEqual({status:'stopped',contained:true});expect(first.supervisor.getStatus().status).toBe('stopped');

    let plannerCalls=0;let executorCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;const nodes:string[]=[];let firstResumedInput:LlmInvocationInput|undefined;
    const resumed=runtimeHarness(root,testConfig(),async(input)=>{if(input.agentName==='planner'){plannerCalls+=1;if(plannerCalls===1)return complete(tool('stopped-activate','activate_card',{card_id:child.id}));if(plannerCalls===2)return complete(tool('stopped-parent-status','write',{path:'record:///status.md?card=project',content:'Stopped test resumed and verified.'}));if(plannerCalls===3)return complete(tool('stopped-parent-done','emit_result',{outcome:'complete_direct',summary:'Resumed test accepted.'}));throw new Error(`Unexpected resumed Planner call ${plannerCalls}`);}const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===child.id)?.processState;if(position?.kind!=='node')throw new Error('missing stopped-reentry position');nodes.push(position.nodeId);executorCalls+=1;if(!firstResumedInput)firstResumedInput=input;const actions=[tool('stopped-diagnose-suite','run_command',{command:passingSuite}),tool('stopped-diagnose-status','write',{path:`record:///status.md?card=${child.id}`,content:'After STOPPED re-entry, the focused suite passes with adequate meaningful coverage. Classification: coverage_ready.'}),tool('stopped-ready','emit_result',{outcome:'coverage_ready',summary:'Retained baseline remains adequately covered and passing.'}),tool('stopped-verify-suite','run_command',{command:passingSuite}),tool('stopped-verify-status','write',{path:`record:///status.md?card=${child.id}`,content:'Post-stop verification accepted the affected suite and coverage.'}),tool('stopped-done','emit_result',{outcome:'done',summary:'Post-stop suite and coverage verified.'})];if(executorCalls===2||executorCalls===5)expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});return complete(actions[executorCalls-1]!);});supervisor=resumed.supervisor;
    expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');expect(nodes).toEqual(['diagnose','diagnose','diagnose','verify','verify','verify']);expect(firstResumedInput!.providerConversation.messages).toEqual(expect.arrayContaining([expect.objectContaining({kind:'synthetic_context',origin:'recovery_notice'}),expect.objectContaining({content:expect.stringContaining('Execution was stopped')} )]));
    const retainedVersion=Number(retainedUrl.match(/&v=(\d+)$/u)![1]);expect(resumed.cards.readRecordVersion(child.id,'status.md',retainedVersion)).toMatchObject({kind:'found',value:{projection:{versionUrl:retainedUrl,artifact:{accepted:{content:'Accepted pre-stop evidence: focused suite passed with meaningful coverage.'}}}}});const versions=resumed.cards.listCardVersions(child.id);if(versions.kind!=='found')throw new Error('missing stopped child history');expect(versions.value.map(({change})=>change?.change_reason)).toEqual(expect.arrayContaining(['recovery stopped lifecycle','STOPPED activation']));expect(resumed.cards.read(child.id)!.lifecycle).toMatchObject({status:'done',result:{node_id:'verify',outcome:'done'}});
  });

  it.each([
    {name:'coverage gap',branch:'gap' as const,nodes:['diagnose','diagnose','add-coverage','add-coverage','add-coverage','verify','verify','verify']},
    {name:'failing test',branch:'failure' as const,nodes:['diagnose','diagnose','diagnose','repair','repair','repair','verify','verify','verify']},
  ])('preserves the $name branch through focused work and verification',async({branch,nodes:expectedNodes})=>{
    let plannerCalls=0;let executorCalls=0;let supervisor!:ReturnType<typeof createSupervisorRuntimeApi>;let childId='';const nodes:string[]=[];
    const run=harness('test',async(input)=>{
      if(input.agentName==='planner'){plannerCalls+=1;if(plannerCalls===1)return complete(tool(`${branch}-activate`,'activate_card',{card_id:childId}));if(plannerCalls===2)return complete(tool(`${branch}-parent-status`,'write',{path:'record:///status.md?card=project',content:`${branch} branch completed through verification.`}));if(plannerCalls===3)return complete(tool(`${branch}-parent-done`,'emit_result',{outcome:'complete_direct',summary:`${branch} branch accepted.`}));throw new Error(`Unexpected ${branch} Planner call ${plannerCalls}`);}
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error(`missing ${branch} test position`);nodes.push(position.nodeId);executorCalls+=1;
      if(branch==='gap'){
        const actions=[tool('gap-status','write',{path:`record:///status.md?card=${childId}`,content:'Diagnosis found no meaningful focused coverage. Classification: coverage_gap.'}),tool('gap-result','emit_result',{outcome:'coverage_gap',summary:'Meaningful focused coverage is missing.'}),tool('gap-suite','run_command',{command:addCoverageSuite}),tool('gap-added-status','write',{path:`record:///status.md?card=${childId}`,content:'Meaningful focused coverage was added and its deterministic suite passes.'}),tool('gap-covered','emit_result',{outcome:'coverage_passing',summary:'Added coverage passes.'}),tool('gap-verify-suite','run_command',{command:verifyInstalledSuite}),tool('gap-verify-status','write',{path:`record:///status.md?card=${childId}`,content:'Verification accepted the affected suite and the new coverage meaning and scope.'}),tool('gap-done','emit_result',{outcome:'done',summary:'Added coverage verified.'})];if(executorCalls===4||executorCalls===7)expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});return complete(actions[executorCalls-1]!);
      }
      const actions=[tool('failure-suite','run_command',{command:installFailingSuite}),tool('failure-status','write',{path:`record:///status.md?card=${childId}`,content:'Focused deterministic fixture failed as observed. Classification: failing_test.'}),tool('failure-result','emit_result',{outcome:'failing_test',summary:'Focused fixture failure observed.'}),tool('repair-suite','run_command',{command:repairSuite}),tool('repair-status','write',{path:`record:///status.md?card=${childId}`,content:'The bounded fixture repair is exercised by a passing deterministic suite.'}),tool('repair-passing','emit_result',{outcome:'tests_passing',summary:'Focused repair passes.'}),tool('repair-verify-suite','run_command',{command:verifyInstalledSuite}),tool('repair-verify-status','write',{path:`record:///status.md?card=${childId}`,content:'Verification accepted the repaired suite and meaningful coverage.'}),tool('repair-done','emit_result',{outcome:'done',summary:'Repaired suite and coverage verified.'})];if(executorCalls===2){const result=latestToolResult(input);expect(result).toMatchObject({success:true,data:{status:'failed'}});expect(result.data?.exit_code).not.toBe(0);}if(executorCalls===5||executorCalls===8)expect(latestToolResult(input)).toMatchObject({success:true,data:{exit_code:0,status:'exited'}});return complete(actions[executorCalls-1]!);
    });supervisor=run.supervisor;childId=run.child.id;expect((await supervisor.startProject()).started).toBe(true);await waitUntil(()=>supervisor.getStatus().status==='stopped');expect(nodes).toEqual(expectedNodes);expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'done',result:{node_id:'verify',outcome:'done'}});
  });

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
    let releasePendingApproval!:()=>void;const pendingApprovalReleased=new Promise<void>((resolve)=>{releasePendingApproval=resolve;});
    let announcePendingApproval!:()=>void;const pendingApprovalAnnounced=new Promise<void>((resolve)=>{announcePendingApproval=resolve;});
    const run=harness('architecture',async(input)=>{
      if(input.agentName==='planner'){
        plannerCalls+=1;if(plannerCalls===1)return complete(tool('activate','activate_card',{card_id:childId}));if(plannerCalls===2)return complete(tool('parent-write','write',{path:'record:///status.md?card=project',content:'Architecture child complete.'}));if(plannerCalls===3)return complete(tool('parent-done','emit_result',{outcome:'complete_direct',summary:'Architecture child accepted.'}));throw new Error(`Unexpected planner call ${plannerCalls}`);
      }
      const position=supervisor.getActorRuntimeReadModel().cards.find(({cardId})=>cardId===childId)?.processState;if(position?.kind!=='node')throw new Error('missing architecture position');
      if(input.agentName==='executor'){
        executorCalls+=1;if(executorCalls%2===1)nodeStarts.push({node:position.nodeId,input});const actions=[tool('draft-one-write','write',{path:`record:///status.md?card=${childId}`,content:'Initial architecture draft.'}),tool('draft-one-result','emit_result',{outcome:'ready_for_component_review',summary:'Initial draft ready.'}),tool('draft-two-write','write',{path:`record:///status.md?card=${childId}`,content:'Revised architecture draft cites system findings.'}),tool('draft-two-result','emit_result',{outcome:'ready_for_component_review',summary:'Revised draft ready.'}),tool('draft-three-write','write',{path:`record:///status.md?card=${childId}`,content:'Notification-aware architecture draft.'}),tool('draft-three-result','emit_result',{outcome:'ready_for_component_review',summary:'Notification-aware draft ready.'})];return complete(actions[executorCalls-1]!);
      }
      reviewerCalls+=1;if(reviewerCalls%2===1)nodeStarts.push({node:position.nodeId,input});const actions=[
        tool('component-one-write','write',{path:`record:///review.md?card=${childId}`,content:'Component review approved.'}),tool('component-one-result','emit_result',{outcome:'approved',summary:'Component scope approved.'}),
        tool('system-one-write','write',{path:`record:///review.md?card=${childId}`,content:'System revision required.'}),tool('system-one-result','emit_result',{outcome:'revision_required',summary:'Address integration invariant.'}),
        tool('component-two-write','write',{path:`record:///review.md?card=${childId}`,content:'Revised component review approved.'}),tool('component-two-result','emit_result',{outcome:'approved',summary:'Revised component scope approved.'}),
        tool('system-two-write','write',{path:`record:///review.md?card=${childId}`,content:'Final system review approved.'}),tool('system-two-result','emit_result',{outcome:'approved',summary:'System scope approved.'}),
        tool('component-three-write','write',{path:`record:///review.md?card=${childId}`,content:'Notification-aware component review approved.'}),tool('component-three-result','emit_result',{outcome:'approved',summary:'Notification-aware component scope approved.'}),
        tool('system-three-write','write',{path:`record:///review.md?card=${childId}`,content:'Notification-aware system review approved.'}),tool('system-three-result','emit_result',{outcome:'approved',summary:'Notification-aware system scope approved.'}),
      ];if(reviewerCalls===8){announcePendingApproval();await pendingApprovalReleased;}return complete(actions[reviewerCalls-1]!);
    });supervisor=run.supervisor;childId=run.child.id;
    expect((await supervisor.startProject()).started).toBe(true);
    await pendingApprovalAnnounced;
    expect(supervisor.notifyCard(childId,{id:'architecture-recipient-context',content:'Reconsider the accepted architecture against the new deployment boundary.',created_at:'2026-09-14T00:00:00.000Z',source:'test'})).toEqual({ok:true,notificationId:'architecture-recipient-context'});
    releasePendingApproval();
    await waitUntil(()=>supervisor.getStatus().status==='stopped');
    expect(nodeStarts.map(({node})=>node)).toEqual(['draft','component-review','system-review','draft','component-review','system-review','draft','component-review','system-review']);
    const contexts=nodeStarts.slice(1).map(({input})=>transitionRows(input).at(-1)!.content);expect(contexts.map((text)=>text.match(/^Previous process node: ([^\n]+)/u)?.[1])).toEqual(['draft','component-review','system-review','draft','component-review','system-review','draft','component-review']);
    for(const {node,input} of nodeStarts.slice(1)){const messages=input.providerConversation.messages;let transitionIndex=-1;for(let index=messages.length-1;index>=0;index-=1){const row=messages[index]!;if(row.role==='user'&&row.kind==='text'&&row.content.startsWith('Previous process node:')){transitionIndex=index;break;}}expect(transitionIndex).toBeGreaterThanOrEqual(0);expect(messages[transitionIndex]!.content).toMatch(/record:\/\/\/(status|review)\.md\?card=card-[a-z-]+&v=\d+/u);const process=run.workflows.cardTypes.get('architecture')!;const compiledNode=process.states.get(`node:${node}`)!;if(compiledNode.kind!=='node')throw new Error(`missing compiled node ${node}`);const selectedText=process.processPrompts.get(compiledNode.promptId)!.text;expect(messages.filter((row)=>row.kind==='synthetic_context'&&row.origin==='dynamic'&&row.block_identity===`node-activation:${childId}:${node}`&&row.content===`Current workflow node '${node}':\n\n${selectedText}`)).toHaveLength(1);expect(messages.slice(transitionIndex+1).some((row)=>row.content===selectedText)).toBe(false);}
    const reviewUrls=contexts.filter((text)=>text.includes('review.md?')).map((text)=>text.match(/record:\/\/\/review\.md\?card=[^\s]+&v=\d+/u)![0]);expect(new Set(reviewUrls).size).toBe(reviewUrls.length);for(const url of reviewUrls){const version=Number(url.match(/&v=(\d+)$/u)![1]);const record=run.cards.readRecordVersion(childId,'review.md',version);expect(record.kind==='found'&&record.value.projection.versionUrl).toBe(url);}
    expect(nodeStarts.filter(({input})=>input.agentName==='reviewer').every(({input})=>!JSON.stringify(input).includes('new deployment boundary'))).toBe(true);
    expect(nodeStarts.find(({node,input})=>node==='draft'&&JSON.stringify(input).includes('new deployment boundary'))).toBeDefined();
    expect(run.cards.read(childId)!.lifecycle).toMatchObject({status:'done',result:{kind:'workflow-result',agent_name:'executor',node_id:'draft',outcome:'ready_for_component_review',summary:'Notification-aware draft ready.',records:[{name:'review.md',url:expect.stringMatching(/&v=\d+$/u)}]}});
    expect(run.cards.readRecordCurrent(childId,'review.md')).toMatchObject({kind:'found',value:{projection:{artifact:{accepted:{content:'Notification-aware system review approved.'}}}}});
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
