import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardStore } from '../cards/card-store.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { AgentMessage } from '../schemas/index.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ProcessRunner } from '../runtime/process-runner.js';
import type { RuntimeGate } from '../runtime/runtime-gate.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore & ProjectRootCardReader;
  invocationService: InvocationService;
  processRunner: ProcessRunner;
  runtimeGate?: RuntimeGate;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  now?: () => string;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeApi {
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    actorStore: deps.cardStore,
    provider: createInvocationServiceProvider(deps.invocationService),
    processRunner: deps.processRunner,
    runtimeGate: deps.runtimeGate,
    mcpManagerProvider: deps.mcpManagerProvider,
    now: deps.now,
  });
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
