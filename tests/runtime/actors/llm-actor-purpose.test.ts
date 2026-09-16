import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationLLMActor,type LlmTerminalHandoff} from '../../../src/runtime/actors/llm-actor.js';
import {ProviderTurnFailure} from '../../../src/agents/llm-contracts.js';
import {LlmRequestError} from '../../../src/contracts/llm-failure.js';
import {prepareCompaction} from '../../../src/runtime/actors/compaction/compactor.js';
import {buildPreparedInvocationContext} from '../../../src/runtime/actors/context/context-blocks.js';
import {initProjectTree} from '../../helpers/canonical-project.js';
import type {LlmInvocationInput} from '../../../src/runtime/actors/llm-invocation.js';
import {appendConversationBatch,readConversation} from '../../../src/persistence/conversation-file.js';
import {agentMessageSchema,CONTENT_POLICY_RETRY_TEXT,parseCanonicalContentPolicyRefusal,type ConversationSessionId} from '../../../src/schemas/index.js';
import type {ProviderExchangeAttempt} from '../../../src/contracts/provider-exchange.js';
import {testApplicationFatalPort} from '../../helpers/test-application-fatal-port.js';
import {scriptedAdmissionProvider,testCompactor,unusedSummarizerProvider} from '../../helpers/llm-test-helpers.js';
import {RuntimeGate} from '../../../src/runtime/runtime-gate.js';

const provider=scriptedAdmissionProvider(async()=>({result:{kind:'message' as const,content:'unused'},provider_exchanges:[]}));
const common={provider,conversations:{projectRoot:'/unused'},compactor:testCompactor,summarizerProvider:unusedSummarizerProvider,fatalPort:testApplicationFatalPort};
const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

function constructorTypeFixtures(): void {
  // @ts-expect-error Autonomous card actors require the shared runtime gate.
  new ConversationLLMActor({...common,agentId:'agent:planner:card-a',purpose:{kind:'autonomous-card',cardId:'card-a'}});
  // @ts-expect-error Analyst actors own their independent gate and prohibit a caller gate.
  new ConversationLLMActor({...common,agentId:'agent:analyst:global',purpose:{kind:'global-agent'},gate:new RuntimeGate()});
}

describe('ConversationLLMActor purpose authority',()=>{
  it('accepts only exact card-purpose/card-session ownership',()=>{
    expect(()=>new ConversationLLMActor({...common,agentId:'agent:planner:card-a',purpose:{kind:'autonomous-card',cardId:'card-a'},gate:new RuntimeGate()})).not.toThrow();
    expect(()=>new ConversationLLMActor({...common,agentId:'agent:planner:global',purpose:{kind:'autonomous-card',cardId:'card-a'},gate:new RuntimeGate()})).toThrow(/does not match session/);
    expect(()=>new ConversationLLMActor({...common,agentId:'agent:planner:card-b',purpose:{kind:'autonomous-card',cardId:'card-a'},gate:new RuntimeGate()})).toThrow(/does not match session/);
  });

  it('accepts Analyst purpose only for a global session',()=>{
    expect(()=>new ConversationLLMActor({...common,agentId:'agent:analyst:global',purpose:{kind:'global-agent'}})).not.toThrow();
    expect(()=>new ConversationLLMActor({...common,agentId:'agent:analyst:card-a',purpose:{kind:'global-agent'}})).toThrow(/requires a global session/);
  });

  it('abandons a retained plain-text turn and returns to idle',async()=>{
    const {projectRoot,input}=cardFixture();
    const completeTurn=jest.fn(async()=>({result:{kind:'message' as const,content:'plain text'},provider_exchanges:[]}));
    const actor=cardActor(projectRoot,scriptedAdmissionProvider(completeTurn));

    await expect(actor.turn(input,undefined,jest.fn())).resolves.toMatchObject({type:'result',result:{content:'plain text'}});
    expect(()=>actor.abandonParkedTurn()).not.toThrow();
    await expect(actor.turn({...input,inputId:'00000000-0000-4000-8000-000000000002'},undefined,jest.fn())).resolves.toMatchObject({type:'result',result:{content:'plain text'}});
    expect(completeTurn).toHaveBeenCalledTimes(2);
    expect(readConversation(projectRoot,input.sessionId).sourceRows.filter(row=>row.role==='assistant'&&row.kind==='text')).toHaveLength(2);
  });

  it('leaves Analyst content refusal terminal with one ordinary provider call',async()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'analyst-purpose-'));roots.push(projectRoot);initProjectTree(projectRoot);
    const timestamp='2026-07-26T00:00:00.000Z';appendConversationBatch({projectRoot},[agentMessageSchema.parse({id:'activation',session_id:'agent:analyst:global',role:'system',kind:'activity',content:JSON.stringify({event:'activation_open',agent_name:'analyst',input_id:'00000000-0000-4000-8000-000000000001',timestamp}),context_policy:{kind:'structural',behavior:'activation_boundary'},round_id:'r-pre-00000000000000000000000000000000',message_index:0,block_index:0,timestamp})]);
    const completeTurn=jest.fn(async(input:LlmInvocationInput)=>{expect(input.routePass.kind).toBe('ordinary');throw new ProviderTurnFailure({failure_phase:'pre_provider',provider_exchanges:[],candidate:{provider:'test',account:null,model:'test-model'},originalFailure:new LlmRequestError({kind:'content_policy',provider:'test',message:'refused',providerResponse:'raw'})});});
    const actor=new ConversationLLMActor({...common,provider:scriptedAdmissionProvider(completeTurn),conversations:{projectRoot},agentId:'agent:analyst:global',purpose:{kind:'global-agent'}});
    const input=preparedInput('agent:analyst:global' as const,'analyst' as const,'agent:analyst:global' as const,'00000000-0000-4000-8000-000000000001',{cardId:'card-a'});
    await expect(actor.turn(input,undefined,()=>undefined)).resolves.toMatchObject({type:'error',error:'refused'});
    expect(completeTurn).toHaveBeenCalledTimes(1);
  });

  it('retries an autonomous card once and combines the successful publication',async()=>{
    const {projectRoot,input}=cardFixture();
    const projectProviderExchanges=jest.fn();
    const completeTurn=jest.fn(async(value:LlmInvocationInput)=>{
      if(completeTurn.mock.calls.length===1)throw refusal(input.inputId,'first-raw');
      expect(value.routePass).toEqual({kind:'pinned-content-policy-retry',candidate:CANDIDATE});
      expect(value.providerConversation.messages.at(-1)).toMatchObject({kind:'synthetic_context',origin:'retry_notice',role:'user',content:CONTENT_POLICY_RETRY_TEXT});
      return {result:{kind:'message' as const,content:'safe answer'},provider_exchanges:[attempt(input.inputId,'ok',0)]};
    });
    const actor=cardActor(projectRoot,{...scriptedAdmissionProvider(completeTurn),projectProviderExchanges});
    const handoff=jest.fn<LlmTerminalHandoff>();
    await expect(actor.turn(input,undefined,handoff)).resolves.toMatchObject({type:'result',result:{content:'safe answer'}});
    expect(completeTurn).toHaveBeenCalledTimes(2);
    expect(projectProviderExchanges).toHaveBeenCalledTimes(1);
    expect(projectProviderExchanges.mock.calls[0]![2]).toMatchObject([{attempt_index:0,status:'error'},{attempt_index:1,status:'ok'}]);
    expect(handoff.mock.calls[0]![0].input.routePass).toEqual({kind:'pinned-content-policy-retry',candidate:CANDIDATE});
    expect(handoff.mock.calls[0]![0].input.providerConversation.messages.at(-1)).toMatchObject({kind:'synthetic_context',origin:'retry_notice'});
    expect(readConversation(projectRoot,input.sessionId).sourceRows.filter(row=>row.kind==='content_policy_retry')).toHaveLength(1);
    expect(readConversation(projectRoot,input.sessionId).sourceRows.filter(row=>row.kind==='content_policy_refusal')).toHaveLength(0);
  });

  it('publishes one terminal marker before one combined refusal projection and hands off BLOCKED',async()=>{
    const {projectRoot,input}=cardFixture();
    const effects:string[]=[];
    const projectProviderExchanges=jest.fn((_session:string,_source:string,attempts:ProviderExchangeAttempt[],context:unknown)=>{effects.push('exchange');expect(attempts).toMatchObject([{attempt_index:0,status:'error'},{attempt_index:1,status:'error'}]);expect(context).toEqual({assistantOutputIds:[],terminalConversationOutputId:expect.any(String)});});
    const completeTurn=jest.fn(async(value:LlmInvocationInput)=>{if(completeTurn.mock.calls.length===1)throw refusal(input.inputId,'first-raw');expect(value.routePass.kind).toBe('pinned-content-policy-retry');throw refusal(input.inputId,'second-raw');});
    const actor=cardActor(projectRoot,{...scriptedAdmissionProvider(completeTurn),projectProviderExchanges});
    const handoff=jest.fn<LlmTerminalHandoff>(()=>{effects.push('handoff');});
    const outcome=await actor.turn(input,undefined,handoff);
    expect(outcome).toMatchObject({type:'blocked',result:{kind:'content-policy-refusal',session_id:input.sessionId,marker_id:expect.any(String)}});
    expect(completeTurn).toHaveBeenCalledTimes(2);
    const rows=readConversation(projectRoot,input.sessionId).sourceRows;
    expect(rows.filter(row=>row.kind==='content_policy_retry')).toHaveLength(1);
    const marker=rows.filter(row=>row.kind==='content_policy_refusal')[0]!;
    expect(parseCanonicalContentPolicyRefusal(marker.content)).toEqual({version:1,type:'content_policy_refusal',source_input_id:input.inputId,candidate:CANDIDATE,provider_response:'second-raw'});
    expect(marker.content).not.toContain('first-raw');
    expect(effects).toEqual(['exchange','handoff']);
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({outcome:expect.objectContaining({type:'blocked'})}));
    expect(handoff.mock.calls[0]![0].input.routePass).toEqual({kind:'pinned-content-policy-retry',candidate:CANDIDATE});
    expect(handoff.mock.calls[0]![0].input.providerConversation.messages.at(-1)).toMatchObject({kind:'synthetic_context',origin:'retry_notice'});
  });
});

const CANDIDATE={provider:'test',account:null,model:'test-model'} as const;
function attempt(source_input_id:string,status:'ok'|'error',attempt_index:number):ProviderExchangeAttempt{return status==='ok'?{contract_id:'test.v1',contract_name:'test',transport:'generic',provider:'test',model:'test-model',source_input_id,attempt_index,request_params:{endpoint:'https://example.invalid',method:'POST',stream:false,offered_tools_count:0,temperature:0,max_tokens:10},started_at:'2026-07-26T00:00:00.000Z',completed_at:'2026-07-26T00:00:01.000Z',status:'ok',terminal_tool_fired:null}:{contract_id:'test.v1',contract_name:'test',transport:'generic',provider:'test',model:'test-model',source_input_id,attempt_index,request_params:{endpoint:'https://example.invalid',method:'POST',stream:false,offered_tools_count:0,temperature:0,max_tokens:10},started_at:'2026-07-26T00:00:00.000Z',completed_at:'2026-07-26T00:00:01.000Z',status:'error',terminal_tool_fired:null,error:{name:'LlmRequestError',message:'refused'}};}
function refusal(inputId:string,raw:string){return new ProviderTurnFailure({failure_phase:'provider_attempt',provider_exchanges:[attempt(inputId,'error',0)],candidate:CANDIDATE,originalFailure:new LlmRequestError({kind:'content_policy',provider:'test',message:'refused',providerResponse:raw})});}
function cardFixture(){const projectRoot=mkdtempSync(join(tmpdir(),'card-purpose-'));roots.push(projectRoot);initProjectTree(projectRoot);const timestamp='2026-07-26T00:00:00.000Z';const inputId='00000000-0000-4000-8000-000000000001';appendConversationBatch({projectRoot},[agentMessageSchema.parse({id:'activation',session_id:'agent:planner:project',role:'system',kind:'activity',content:JSON.stringify({event:'activation_open',agent_name:'planner',card_id:'project',input_id:inputId,timestamp}),context_policy:{kind:'structural',behavior:'activation_boundary'},round_id:'r-pre-00000000000000000000000000000000',message_index:0,block_index:0,timestamp})]);const input=preparedInput('agent:planner:project','planner','agent:planner:project',inputId,{});return{projectRoot,input};}
function preparedInput(agentId:string,agentName:'planner'|'analyst',sessionId:ConversationSessionId,inputId:string,episodeContext:Record<string,unknown>){const preparedCompaction=prepareCompaction({context_utilization_fraction:.8,trigger_fraction:.8,tail_fraction:.25,snap:'compact_straddler'},'system',[],8_000,2_000);return{inputId,agentId,agentName,sessionId,systemPrompt:'system',providerConversation:{sourceSessionId:sessionId,messages:[]},tools:[],compiledToolContracts:[],terminalToolNames:[],modelParams:{temperature:0},preparedCompaction,preparedContext:buildPreparedInvocationContext({instructionText:'system',terminalToolNames:[],compiledTools:[],dynamicBlocks:[],preparedCompaction}),capabilityRequest:{},routePass:{kind:'ordinary' as const,candidateChain:[CANDIDATE]},episodeContext};}
function cardActor(projectRoot:string,provider:ConstructorParameters<typeof ConversationLLMActor>[0]['provider']){return new ConversationLLMActor({...common,provider,conversations:{projectRoot},agentId:'agent:planner:project',purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate()});}
