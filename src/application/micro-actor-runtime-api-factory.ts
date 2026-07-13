import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardStoreRepository } from '../cards/card-store.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { parseCandidateKey } from '../contracts/provider-candidate.js';
import { compact, heuristicBufferSizeEstimator, shouldCompact } from '../runtime/actors/compaction/compactor.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';
import type { PromptTemplateRegistry } from '../utils/prompt-api.js';
import { activeConversationReplayForInvocation, genericContextMessagesForInvocation } from '../runtime/actors/llm-invocation.js';
import type { ConversationMutationPort } from '../persistence/conversation-mutation-port.js';
import type { ReadModelChanges } from './read-model-changes.js';
import type { CompositionMutationAuthority } from './mutation-authority.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStoreRepository & ProjectRootCardReader;
  compositionAuthority: CompositionMutationAuthority;
  invocationService: InvocationService;
  promptTemplates: PromptTemplateRegistry;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  now?: () => string;
  conversations: ConversationMutationPort;
  readModelChanges: ReadModelChanges;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeApi {
  const compaction = deps.config?.compaction?.enabled === true ? buildCompactionWiring(deps.invocationService, deps.config) : undefined;
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    actorStore: deps.cardStore,
    compositionAuthority: deps.compositionAuthority,
    provider: createInvocationServiceProvider(deps.invocationService),
    compactor: compaction?.compactor,
    compactionConfig: compaction?.compactionConfig,
    summarizerProvider: compaction?.summarizerProvider,
    bufferSizeEstimator: compaction?.bufferSizeEstimator,
    processRunner: deps.processRunner,
    promptTemplates: deps.promptTemplates,
    runtimeGate: deps.runtimeGate,
    mcpManagerProvider: deps.mcpManagerProvider,
    now: deps.now,
    conversations: deps.conversations,
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
    bufferSizeEstimator: heuristicBufferSizeEstimator,
    summarizerProvider: {
      completeTurn: (input: Parameters<LLMProviderPort['completeTurn']>[0], signal: AbortSignal, mutationAuthority: Parameters<LLMProviderPort['completeTurn']>[2]) => invocationService.invokeWithRecovery({
        inputId: input.inputId,
        mutationAuthority,
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
    completeTurn: (input, signal, mutationAuthority) => invocationService.invokeWithRecovery({
      inputId: input.inputId,
      mutationAuthority,
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
  };
}
