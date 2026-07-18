import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeControlMechanics } from './runtime-control-service.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardService } from '../cards/card-service.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { AutonomousCompactionPolicy } from '../runtime/actors/compaction/compactor.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';
import type { PromptTemplateRegistry } from '../utils/prompt-api.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { ReadModelChanges } from './read-model-changes.js';
import type { RuntimeInterventionBinding } from './intervention-readiness.js';
import type { InvocationRequest } from '../agents/invocation-service.js';
import type { LlmInvocationInput } from '../runtime/actors/llm-invocation.js';
import type { SummarizerProviderPort } from '../runtime/actors/compaction/summarizer.js';
import type { CompactorPort } from '../runtime/actors/llm-actor.js';
import type { RuntimeProcessIdentity } from '../runtime/lock.js';
import type { CompiledCardProcesses } from '../runtime/card-process/card-process-config.js';
import type { ProcessPromptRegistry } from '../runtime/card-process/process-prompt-registry.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  processIdentity: RuntimeProcessIdentity;
  eventBus: EventBus;
  cardStore: CardService & ProjectRootCardReader;
  interventionBinding: RuntimeInterventionBinding;
  invocationService: InvocationService;
  promptTemplates: PromptTemplateRegistry;
  cardProcesses: CompiledCardProcesses;
  processPrompts: ProcessPromptRegistry;
  compactionPolicy: AutonomousCompactionPolicy;
  compactor: CompactorPort;
  summarizerProvider: SummarizerProviderPort;
  processRunner: ProcessRunner;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  now?: () => string;
  conversations: ConversationFileContext;
  appLogs: AppLogContext;
  readModelChanges: ReadModelChanges;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeControlMechanics {
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    processIdentity: deps.processIdentity,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    actorStore: deps.cardStore,
    interventionBinding: deps.interventionBinding,
    provider: createInvocationServiceProvider(deps.invocationService),
    compactor: deps.compactor,
    compactionConfig: deps.compactionPolicy,
    summarizerProvider: deps.summarizerProvider,
    processRunner: deps.processRunner,
    promptTemplates: deps.promptTemplates,
    runtimeGate: deps.runtimeGate,
    mcpManagerProvider: deps.mcpManagerProvider,
    now: deps.now,
    conversations: deps.conversations,
    appLogs: deps.appLogs,
    readModelChanges: deps.readModelChanges,
  });
}

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery(invocationRequest(input, signal)),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, assistantOutputIds) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds),
  };
}

export function invocationRequest(input: LlmInvocationInput, signal: AbortSignal, candidateChain?: NonNullable<InvocationRequest['candidateChain']>): InvocationRequest {
  const common = {
    inputId: input.inputId, role: input.role, sessionId: input.sessionId, systemPrompt: input.systemPrompt,
    providerConversation: input.providerConversation,
    tools: input.tools, terminalToolNames: input.terminalToolNames, capabilityRequest: input.capabilityRequest, abortSignal: signal,
    ...(candidateChain ? { candidateChain } : {}),
  };
  return input.preparedCompaction
    ? { ...common, modelParams: input.modelParams, preparedCompaction: input.preparedCompaction }
    : { ...common, modelParams: input.modelParams };
}
