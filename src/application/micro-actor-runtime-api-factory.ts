import { createSupervisorRuntimeApi, type SupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { LLMProviderPort } from '../runtime/actors/index.js';
import type { CardService } from '../cards/card-service.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { ManagedProcessScope } from '../runtime/managed-process-group-registry.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';
import type { PromptTemplateRegistry } from '../utils/prompt-api.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import type { FreshnessEffects } from './freshness-effects.js';
import type { RuntimeInterventionBinding } from './intervention-readiness.js';
import type { InvocationRequest } from '../agents/invocation-service.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import type { RuntimeProcessIdentity } from '../runtime/lock.js';
import type { CompiledRuntimeWorkflows } from '../runtime/card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../runtime/card-process/process-prompt-registry.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  processIdentity: RuntimeProcessIdentity;
  cardStore: CardService;
  interventionBinding: RuntimeInterventionBinding;
  invocationService: InvocationService;
  promptTemplates: PromptTemplateRegistry;
  workflows: CompiledRuntimeWorkflows;
  processPrompts: ProcessPromptRegistry;
  compactionPolicy: AutonomousCompactionPolicy;
  compactor: CompactorPort;
  summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  runtimeGate: RuntimeGate;
  mcpToolInvocation: McpToolInvocationPort;
  conversations: ConversationFileContext;
  freshness: Pick<FreshnessEffects, 'runtimeChanged' | 'agentsChanged' | 'conversationChanged'>;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): SupervisorRuntimeApi {
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    processIdentity: deps.processIdentity,
    actorStore: deps.cardStore,
    interventionBinding: deps.interventionBinding,
    provider: createInvocationServiceProvider(deps.invocationService),
    compactor: deps.compactor,
    compactionConfig: deps.compactionPolicy,
    summarizerProvider: deps.summarizerProvider,
    processRunner: deps.processRunner,
    runtimeProcessRootScope: deps.runtimeProcessRootScope,
    promptTemplates: deps.promptTemplates,
    workflows: deps.workflows,
    processPrompts: deps.processPrompts,
    runtimeGate: deps.runtimeGate,
    mcpToolInvocation: deps.mcpToolInvocation,
    conversations: deps.conversations,
    freshness: deps.freshness,
  });
}

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal)),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, assistantOutputIds, operationError) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds, operationError),
  };
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal, candidateChain?: NonNullable<InvocationRequest['candidateChain']>): InvocationRequest {
  const boundCandidates=candidateChain??input.candidateChain;
  if(!boundCandidates)throw new Error(`LLM invocation for agent '${input.agentName}' has no bound candidate chain.`);
  const common = {
    inputId: input.inputId, agentName: input.agentName, sessionId: input.sessionId, systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools, terminalToolNames: input.terminalToolNames, capabilityRequest: input.capabilityRequest, abortSignal: signal,
    candidateChain: [...boundCandidates],
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
    : { ...common, modelParams: input.modelParams };
}
