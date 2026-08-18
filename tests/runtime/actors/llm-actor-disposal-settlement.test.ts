import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationLLMActor} from '../../../src/runtime/actors/llm-actor.js';
import {appendConversationBatch,readConversation,type ConversationFileContext} from '../../../src/persistence/conversation-file.js';
import {agentMessageSchema,canonicalJson} from '../../../src/schemas/index.js';
import {prepareCompaction} from '../../../src/runtime/actors/compaction/compactor.js';
import {initProjectTree} from '../../helpers/canonical-project.js';
import {testApplicationFatalPort} from '../../helpers/test-application-fatal-port.js';
import {scriptedAdmissionProvider,testCompactor,unusedSummarizerProvider} from '../../helpers/llm-test-helpers.js';
import {executedNoneSettlement,settlementProviderResult,type ExecutedToolSettlement} from '../../../src/tools/invocation.js';

const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('ConversationLLMActor disposal after tool-result writer entry',()=>{
  it('keeps the ordinary caller result, rejects its caller, and admits no continuation',async()=>{
    const fixture=await toolCallFixture('demo');
    const disposalReason=new Error('application disposed during ordinary result publication');
    const continuation=jest.fn((_continuationInputId:string)=>undefined);
    fixture.observer.arm(()=>fixture.actor.dispose(disposalReason));
    const settlement=executedNoneSettlement({success:true,data:{value:'caller supplied'}});

    await expect(fixture.actor.appendToolResult(fixture.outcome.toolCallId,settlement,undefined,continuation)).rejects.toBe(disposalReason);

    fixture.observer.expectOnePublication();
    expectToolResult(fixture,settlement,'demo');
    expect(continuation).not.toHaveBeenCalled();
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await expect(fixture.actor.turn(fixture.input,undefined,jest.fn())).rejects.toThrow('invocation admission is closed');
    await expect(fixture.actor.continueAfterPlainText('repair',undefined,jest.fn())).rejects.toThrow('no open plain-text result');
    await expect(fixture.actor.appendToolResult(fixture.outcome.toolCallId,settlement)).rejects.toThrow('not waiting for a tool result');
    await expect(fixture.actor.join()).resolves.toEqual({status:'joined'});
  });

  it('keeps the successful restart_server result, rejects its caller, and installs no later activity',async()=>{
    const fixture=await toolCallFixture('restart_server');
    const disposalReason=new Error('application disposed during restart result publication');
    fixture.observer.arm(()=>fixture.actor.dispose(disposalReason));
    const settlement=executedNoneSettlement({success:true,data:{accepted:true}});

    await expect(fixture.actor.settleToolResultWithoutContinuation(fixture.outcome.toolCallId,settlement)).rejects.toBe(disposalReason);

    fixture.observer.expectOnePublication();
    expectToolResult(fixture,settlement,'restart_server');
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await expect(fixture.actor.turn(fixture.input,undefined,jest.fn())).rejects.toThrow('invocation admission is closed');
    await expect(fixture.actor.continueAfterPlainText('repair',undefined,jest.fn())).rejects.toThrow('no open plain-text result');
    await expect(fixture.actor.settleToolResultWithoutContinuation(fixture.outcome.toolCallId,settlement)).rejects.toThrow('not waiting for a tool result');
    await expect(fixture.actor.join()).resolves.toEqual({status:'joined'});
  });
});

async function toolCallFixture(toolName:string){
  const projectRoot=mkdtempSync(join(tmpdir(),'llm-disposal-settlement-'));roots.push(projectRoot);initProjectTree(projectRoot);
  const sessionId='agent:analyst:global' as const;
  const inputId='00000000-0000-4000-8000-000000000001';
  const timestamp='2026-08-11T00:00:00.000Z';
  const observer=publicationObserver();
  const conversations:ConversationFileContext={projectRoot,changes:{conversationChanged:observer.conversationChanged,agentMembershipChanged:jest.fn()}};
  appendConversationBatch(conversations,[agentMessageSchema.parse({id:'activation',session_id:sessionId,role:'system',kind:'activity',content:JSON.stringify({event:'activation_open',agent_name:'analyst',input_id:inputId,timestamp}),context_policy:{kind:'structural',behavior:'activation_boundary'},round_id:'r-pre-00000000000000000000000000000000',message_index:0,block_index:0,timestamp})]);
  const completeTurn=jest.fn(async()=>({result:{kind:'tool_calls' as const,tool_calls:[{id:'call-1',type:'function' as const,function:{name:toolName,arguments:'{}'}}]},provider_exchanges:[]}));
  const actor=new ConversationLLMActor({purpose:{kind:'analyst'},agentId:sessionId,provider:scriptedAdmissionProvider(completeTurn),conversations,compactor:testCompactor,summarizerProvider:unusedSummarizerProvider,fatalPort:testApplicationFatalPort});
  const input={inputId,agentId:sessionId,agentName:'analyst' as const,sessionId,systemPrompt:'system',providerConversation:{sourceSessionId:sessionId,messages:[]},tools:[],compiledToolContracts:[],terminalToolNames:[],modelParams:{temperature:0},preparedCompaction:prepareCompaction({input_budget_tokens:1000,trigger_fraction:.8,completion_reserve_fraction:.2,merge_line_fraction:.3,summary_line_fraction:.5,escalate_merge_line_fraction:.4,escalate_summary_line_fraction:.6,snap:'compact_straddler'},'system',[]),capabilityRequest:{},routePass:{kind:'ordinary' as const,candidateChain:[{provider:'test',account:null,model:'test-model'}]},episodeContext:{}};
  const outcome=await actor.turn(input,undefined,jest.fn());
  if(outcome.type!=='tool_call')throw new Error('Fixture provider did not produce a tool call.');
  return{actor,completeTurn,conversations,input,outcome,observer};
}

function publicationObserver(){
  let armed:(()=>void)|null=null;
  let fired=0;
  return{
    conversationChanged:jest.fn(()=>{if(!armed)return;const effect=armed;armed=null;fired+=1;effect();}),
    arm(effect:()=>void){if(armed)throw new Error('Publication observer is already armed.');armed=effect;},
    expectOnePublication(){expect(fired).toBe(1);expect(armed).toBeNull();},
  };
}

function expectToolResult(fixture:Awaited<ReturnType<typeof toolCallFixture>>,settlement:ExecutedToolSettlement,toolName:string):void{
  const rows=readConversation(fixture.conversations.projectRoot,fixture.input.sessionId).sourceRows;
  const results=rows.filter(row=>row.kind==='tool_result');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({id:`${fixture.input.inputId}:tool-result:${fixture.outcome.toolCallId}`,session_id:fixture.input.sessionId,role:'tool',kind:'tool_result',tool:toolName,tool_call_id:fixture.outcome.toolCallId,content:canonicalJson(settlementProviderResult(settlement))});
  expect(rows.at(-1)).toBe(results[0]);
  expect(rows.some(row=>row.content.includes('confirmation_required'))).toBe(false);
  expect(rows.some(row=>row.content.includes('Cancelled:'))).toBe(false);
}
