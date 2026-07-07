import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardStore } from '../cards/card-store.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { SaivageConfig } from '../agents/config-api.js';
import { parseCandidateKey } from '../contracts/provider-candidate.js';
import { compact, heuristicBufferSizeEstimator, shouldCompact } from '../runtime/actors/compaction/compactor.js';
import type { AgentMessage } from '../schemas/index.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore & ProjectRootCardReader;
  invocationService: InvocationService;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  now?: () => string;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeApi {
  const compaction = deps.config?.compaction?.enabled === true ? buildCompactionWiring(deps.invocationService, deps.config) : undefined;
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    actorStore: deps.cardStore,
    provider: createInvocationServiceProvider(deps.invocationService),
    compactor: compaction?.compactor,
    compactionConfig: compaction?.compactionConfig,
    summarizerProvider: compaction?.summarizerProvider,
    bufferSizeEstimator: compaction?.bufferSizeEstimator,
    processRunner: deps.processRunner,
    runtimeGate: deps.runtimeGate,
    mcpManagerProvider: deps.mcpManagerProvider,
    now: deps.now,
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
      completeTurn: (input: Parameters<LLMProviderPort['completeTurn']>[0], signal: AbortSignal) => invocationService.invokeWithRecovery({
        role: input.role,
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        contextMessages: input.contextMessages as AgentMessage[],
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
      role: input.role,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      contextMessages: input.contextMessages as AgentMessage[],
      tools: input.tools,
      terminalToolNames: input.terminalToolNames,
      modelParams: input.modelParams,
      capabilityRequest: input.capabilityRequest,
      abortSignal: signal,
    }),
  };
}
