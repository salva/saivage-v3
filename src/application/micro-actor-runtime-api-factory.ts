import { createSupervisorRuntimeApi } from '../runtime/actors/index.js';
import type { EventBus } from '../events/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { RuntimeContextCardReader } from '../runtime/context-builder.js';
import type { LLMProviderPort, ProjectRootCardReader } from '../runtime/actors/index.js';
import type { CardStore } from '../cards/card-store.js';
import type { InvocationService } from '../agents/invocation-service.js';
import type { AgentMessage } from '../schemas/index.js';

export interface MicroActorRuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore & ProjectRootCardReader & RuntimeContextCardReader;
  invocationService?: InvocationService;
  now?: () => string;
}

export function createMicroActorRuntimeApi(deps: MicroActorRuntimeApiFactoryDeps): RuntimeApi {
  return createSupervisorRuntimeApi({
    projectRoot: deps.projectRoot,
    eventBus: deps.eventBus,
    rootCards: deps.cardStore,
    contextCards: deps.cardStore,
    actorStore: deps.invocationService ? deps.cardStore : undefined,
    provider: deps.invocationService ? invocationServiceProvider(deps.invocationService) : undefined,
    now: deps.now,
  });
}

function invocationServiceProvider(invocationService: InvocationService): LLMProviderPort {
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
