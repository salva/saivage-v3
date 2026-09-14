import { randomUUID } from 'node:crypto';
import type { AgentName, CardTypeName, GlobalConversationSessionId } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { CapabilityRequest } from './provider-capabilities.js';
import { buildGlobalAgentIngressRows, providerConversationProjection } from '../runtime/actors/conversation-session.js';
import { ConversationLLMActor, LastChanceSummaryProviderUnavailableError, type CompactorPort, type LLMProviderPort } from '../runtime/actors/llm-actor.js';
import { LocalExactAdmissionError } from './invocation-admission.js';
import { ProviderTurnFailure } from './llm-contracts.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import { CompactionSummaryConstructionError, prepareCompaction, type AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import { appendConversationBatch, initializeMissingConversation, readConversation } from '../persistence/conversation-file.js';
import { buildPreparedInvocationContext } from '../runtime/actors/context/context-blocks.js';
import type { PromptTemplateRegistry } from '../utils/prompt-api.js';
import { surfaceToolContracts } from '../tools/runtime-tool-catalog.js';
import { invokeToolForLlm, surfaceToolDefinitions, syntheticToolSettlement, type InvocationSurface } from '../tools/invocation.js';
import { parseProtocolToolArgs } from './agent-protocol-violation.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import type { ExecutingLlmSnapshot } from '../runtime/actors/executing-llm-snapshot.js';
import { settleReturnedToolCallWithoutEntry } from '../runtime/actors/returned-tool-call-settlement.js';
import { formatVocabularySnippet } from './analyst-prompt.js';

export type OversightCheckOutcome = 'succeeded'|'failed'|'cancelled';

export class OversightSession {
  readonly #sessionId:GlobalConversationSessionId;
  readonly #agentName:AgentName;
  readonly #surface:InvocationSurface;
  readonly #llm:ConversationLLMActor;
  readonly #conversations:ConversationFileContext;
  readonly #promptTemplates:PromptTemplateRegistry;
  readonly #modelParams:Readonly<{temperature:number;maxTokens:number}>;
  readonly #capabilityRequest:CapabilityRequest;
  readonly #candidateChain:readonly Candidate[];
  readonly #routeUsableInputTokens:number;
  readonly #compactionPolicy:AutonomousCompactionPolicy;
  readonly #fatalPort:ApplicationFatalPort;
  readonly #cardTypeVocabulary:readonly CardTypeName[];
  readonly #runtimeProjectionChanged:()=>void;
  #task:Promise<OversightCheckOutcome>|null=null;
  #abort:AbortController|null=null;

  constructor(input:{sessionId:GlobalConversationSessionId;agentName:AgentName;surface:InvocationSurface;provider:LLMProviderPort;conversations:ConversationFileContext;promptTemplates:PromptTemplateRegistry;modelParams:Readonly<{temperature:number;maxTokens:number}>;capabilityRequest:CapabilityRequest;candidateChain:readonly Candidate[];routeUsableInputTokens:number;compactionPolicy:AutonomousCompactionPolicy;compactor:CompactorPort;summarizerProvider:SummarizerProviderPort;runtimeProjectionChanged():void;fatalPort:ApplicationFatalPort;cardTypeVocabulary:readonly CardTypeName[]}) {
    this.#sessionId=input.sessionId;this.#agentName=input.agentName;this.#surface=input.surface;this.#conversations=input.conversations;this.#promptTemplates=input.promptTemplates;this.#modelParams=input.modelParams;this.#capabilityRequest=input.capabilityRequest;this.#candidateChain=input.candidateChain;this.#routeUsableInputTokens=input.routeUsableInputTokens;this.#compactionPolicy=input.compactionPolicy;this.#fatalPort=input.fatalPort;this.#cardTypeVocabulary=input.cardTypeVocabulary;this.#runtimeProjectionChanged=input.runtimeProjectionChanged;
    this.#llm=new ConversationLLMActor({purpose:{kind:'global-agent'},agentId:input.sessionId,provider:input.provider,conversations:input.conversations,compactor:input.compactor,summarizerProvider:input.summarizerProvider,runtimeProjectionChanged:input.runtimeProjectionChanged,fatalPort:input.fatalPort});
  }

  run():Promise<OversightCheckOutcome>{
    if(this.#task)throw new Error('Oversight check is already active.');
    this.#abort=new AbortController();
    const task=this.#run(this.#abort.signal);
    this.#task=task.finally(()=>{this.#task=null;this.#abort=null;this.#runtimeProjectionChanged();});
    return this.#task;
  }

  cancel(reason:unknown):void{if(!this.#abort)return;this.#llm.requestGracefulCancellation(reason);if(!this.#abort.signal.aborted)this.#abort.abort(reason);}
  assertEffectSignal(signal: AbortSignal): void {
    if (this.#abort?.signal !== signal) throw new Error('Oversight effect signal does not belong to the active check.');
    signal.throwIfAborted();
  }
  async join():Promise<void>{const task=this.#task;if(task)await task;await this.#llm.join();}
  executingLlmSnapshot():ExecutingLlmSnapshot|null{return this.#task?Object.freeze({sessionId:this.#sessionId,agentId:this.#llm.agentId,agentName:this.#agentName,cardId:null,activity:this.#llm.executingActivity(),compaction:this.#llm.compactionProgress()}):null;}

  async #run(signal:AbortSignal):Promise<OversightCheckOutcome>{
    try {
      signal.throwIfAborted();
      const inputId=randomUUID();
      const tools=surfaceToolDefinitions(this.#surface);const compiledToolContracts=surfaceToolContracts(this.#surface);
      const systemPrompt=this.#promptTemplates.render({kind:'global-agent'},this.#agentName,{vocabularySnippet:formatVocabularySnippet(this.#cardTypeVocabulary)});
      const preparedCompaction=prepareCompaction(this.#compactionPolicy,systemPrompt,tools,this.#routeUsableInputTokens,this.#modelParams.maxTokens);
      const prepared={inputId,agentId:this.#sessionId,agentName:this.#agentName,sessionId:this.#sessionId,systemPrompt,tools,compiledToolContracts,terminalToolNames:[],modelParams:{temperature:this.#modelParams.temperature},preparedCompaction,preparedContext:buildPreparedInvocationContext({instructionText:systemPrompt,terminalToolNames:[],compiledTools:compiledToolContracts,dynamicBlocks:[],preparedCompaction}),capabilityRequest:this.#capabilityRequest,routePass:{kind:'ordinary' as const,candidateChain:this.#candidateChain},episodeContext:{surface:'scheduled-oversight'}};
      signal.throwIfAborted();
      initializeMissingConversation(this.#conversations.projectRoot,this.#sessionId);
      appendConversationBatch(this.#conversations,buildGlobalAgentIngressRows(this.#sessionId,inputId,'Perform one proportionate project Oversight check. No action is a successful result.'));
      signal.throwIfAborted();
      let outcome=await this.#llm.turn({...prepared,providerConversation:providerConversationProjection(readConversation(this.#conversations.projectRoot,this.#sessionId),[])},signal,()=>undefined);
      for(;;){
        if(signal.aborted){
          await settleReturnedToolCallWithoutEntry(this.#llm,outcome,'Oversight check cancelled before tool execution.');
          return this.#settleOrdinary('cancelled');
        }
        if(outcome.type==='result')return this.#settleOrdinary(signal.aborted?'cancelled':'succeeded');
        if(outcome.type==='error'||outcome.type==='blocked')return this.#settleOrdinary(signal.aborted?'cancelled':'failed');
        const parsed=parseProtocolToolArgs(this.#llm.waitingToolArguments(outcome));
        let settlement;
        try{settlement=parsed.kind==='ok'&&this.#surface.tools.has(outcome.toolName)
          ? await invokeToolForLlm(this.#surface,outcome.toolName,parsed.args,this.#llm.toolInvocationContext(outcome),signal)
          : syntheticToolSettlement('rejected_before_execution',parsed.kind==='violation'?'Invalid tool arguments.':'Unsupported Oversight tool.');}
        catch(error){if(!signal.aborted||error!==signal.reason)throw error;return this.#settleOrdinary('cancelled');}
        if(signal.aborted){await this.#llm.settleToolResultWithoutContinuation(outcome.toolCallId,settlement);return this.#settleOrdinary('cancelled');}
        outcome=(await this.#llm.appendToolResult(outcome.toolCallId,settlement,signal)).outcome;
      }
    } catch(error){
      if(error instanceof PublicationOutcomeUnknownError)this.#fatalPort.publicationOutcomeUnknown(error);
      if(signal.aborted&&error===signal.reason)return this.#settleOrdinary('cancelled',error);
      if(isExpectedOversightFailure(error))return this.#settleOrdinary('failed',error);
      throw error;
    }
  }

  async #settleOrdinary(outcome:OversightCheckOutcome,expectedJoinFailure?:unknown):Promise<OversightCheckOutcome>{
    this.#llm.dispose(new Error('Oversight check settled.'));
    try{await this.#llm.join();}
    catch(error){if(error!==expectedJoinFailure)throw error;}
    return outcome;
  }
}

function isExpectedOversightFailure(error:unknown):boolean{return error instanceof LocalExactAdmissionError||error instanceof ProviderTurnFailure||error instanceof LastChanceSummaryProviderUnavailableError||error instanceof CompactionSummaryConstructionError;}
