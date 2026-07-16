import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeControlMechanics } from './runtime-control-service.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardService } from '../cards/card-service.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { parseCandidateKey } from '../contracts/provider-candidate.js';
import { compact, shouldCompact } from '../runtime/actors/compaction/compactor.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';
import type { PromptTemplateRegistry } from '../utils/prompt-api.js';
import { activeConversationReplayForInvocation, genericContextMessagesForInvocation } from '../runtime/actors/llm-invocation.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { ReadModelChanges } from './read-model-changes.js';
import type { RuntimeInterventionBinding } from './intervention-readiness.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardService & ProjectRootCardReader;
  interventionBinding: RuntimeInterventionBinding;
  invocationService: InvocationService;
  promptTemplates: PromptTemplateRegistry;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  now?: () => string;
  conversations: ConversationFileContext;
  appLogs: AppLogContext;
  readModelChanges: ReadModelChanges;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeControlMechanics {
  const compaction = deps.config?.compaction?.enabled === true ? buildCompactionWiring(deps.invocationService, deps.config) : undefined;
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    actorStore: deps.cardStore,
    interventionBinding: deps.interventionBinding,
    provider: createInvocationServiceProvider(deps.invocationService),
    compactor: compaction?.compactor,
    compactionConfig: compaction?.compactionConfig,
    summarizerProvider: compaction?.summarizerProvider,
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

function buildCompactionWiring(invocationService: InvocationService, config: SaivageConfig) {
  const compactionConfig = config.compaction;
  if (!compactionConfig) throw new Error('compaction.enabled=true requires compaction configuration.');
  const spec = compactionConfig.summarizer_model;
  if (!spec) throw new Error('compaction.enabled=true requires compaction.summarizer_model.');
  const candidate = parseCandidateKey(spec);
  return {
    compactor: { shouldCompact, compact },
    compactionConfig,
    summarizerProvider: {
      completeTurn: (input: Parameters<LLMProviderPort['completeTurn']>[0], signal: AbortSignal) => invocationService.invokeWithRecovery({
        inputId: input.inputId,
        role: input.role,
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        genericContextMessages: genericContextMessagesForInvocation(input),
        activeConversationReplay: activeConversationReplayForInvocation(input),
        tools: input.tools,
        terminalToolNames: input.terminalToolNames,
        modelParams: input.modelParams,
        capabilityRequest: input.capabilityRequest,
        abortSignal: signal,
        candidateChain: [candidate],
      }),
    },
  };
}

export function createInvocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
  return {
    completeTurn: (input, signal) => invocationService.invokeWithRecovery({
      inputId: input.inputId,
      role: input.role,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      genericContextMessages: genericContextMessagesForInvocation(input),
      activeConversationReplay: activeConversationReplayForInvocation(input),
      tools: input.tools,
      terminalToolNames: input.terminalToolNames,
      modelParams: input.modelParams,
      capabilityRequest: input.capabilityRequest,
      abortSignal: signal,
    }),
    projectProviderExchanges: (sessionId, sourceInputId, attempts, assistantOutputIds) => invocationService.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds),
  };
}
