import type { SaivageConfig } from '../agents/config-api.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { FsCandidateAvailability } from '../agents/candidate-availability-store.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import type { AnalystRuntimeDeps } from '../agents/analyst-api.js';
import { ProviderRegistry } from '../agents/provider.js';
import { ModelRouter } from '../agents/model-router.js';
import type { EventPayload } from '../events/index.js';
import type { EventBus } from '../events/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../observability/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';

import { CardStore } from '../cards/card-store.js';
import { InvocationService } from '../agents/invocation-service.js';
import { createInvocationServiceProvider, createMicroActorRuntimeApi } from './micro-actor-runtime-api-factory.js';

export interface RuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore;
  invocationService: InvocationService;
  mcpManagerProvider?: () => McpManager | undefined;
}

type DisposableCandidateAvailability = CandidateAvailability & { dispose(): void };

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardStore;
  readonly analystDeps: AnalystRuntimeDeps;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
  setMcpManager(mcpManager: McpManager): void;
}

export interface RuntimeApplicationServices {
  projectRoot: string;
  config: SaivageConfig;
  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  cardStore: CardStore;
  runtimeApiFactory?: (deps: RuntimeApiFactoryDeps) => RuntimeApi;
}

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  cardStore: CardStore;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  eventBus: EventBus;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  invocationService: InvocationService;
  mcpManager?: McpManager;
}): AnalystRuntimeDeps {
  return {
    runtime: input.runtimeApi,
    cardStore: input.cardStore,
    candidateAvailability: input.candidateAvailability,
    eventLogger: input.eventLogger,
    eventBus: input.eventBus,
    emitAnalystToolInvoked: input.emitAnalystToolInvoked,
    provider: createInvocationServiceProvider(input.invocationService),
    mcpManager: input.mcpManager,
  };
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const { projectRoot, config, eventBus, eventLogger, errorLogger, cardStore } = services;
  const candidateAvailability = new FsCandidateAvailability(projectRoot, {
    compactBytes: config.runtime.candidateAvailabilityCompactBytes,
  });
  let mcpManager: McpManager | undefined;

  const registry = new ProviderRegistry(config);
  const router = new ModelRouter(
    config,
    registry,
    projectRoot,
    candidateAvailability,
  );
  const invocationService = new InvocationService({
    projectRoot,
    saivageDir: `${projectRoot}/.saivage`,
    registry,
    router,
    eventLogger,
    candidateAvailability,
  });

  const runtimeFactory = services.runtimeApiFactory ?? createMicroActorRuntimeApi;
  const runtimeComposition = createComposedRuntimeApi({
    runtimeApi: runtimeFactory({ projectRoot, eventBus, cardStore, invocationService, mcpManagerProvider: () => mcpManager }),
    candidateAvailability,
    eventLogger,
    errorLogger,
    eventBus,
  });
  const runtimeApi = runtimeComposition.runtimeApi;
  const emitAnalystToolInvokedFromRuntime = runtimeComposition.emitAnalystToolInvoked;
  let analystDepsCache: AnalystRuntimeDeps | null = null;
  const getAnalystDeps = (): AnalystRuntimeDeps => {
    analystDepsCache ??= buildAnalystDeps({
      runtimeApi,
      cardStore,
      candidateAvailability,
      eventLogger,
      eventBus,
      emitAnalystToolInvoked: emitAnalystToolInvokedFromRuntime,
      invocationService,
      mcpManager,
    });
    return analystDepsCache;
  };

  return {
    runtimeApi,
    cardStore,
    get analystDeps() {
      return getAnalystDeps();
    },
    getProviderRoutingReadModel() {
      return buildProviderRoutingReadModel({
        registry,
        availability: candidateAvailability,
      });
    },
    setMcpManager(nextMcpManager) {
      mcpManager = nextMcpManager;
      analystDepsCache = null;
      nextMcpManager.setEventLogger(eventLogger);
    },
  };
}

function createComposedRuntimeApi(input: {
  runtimeApi: RuntimeApi;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  eventBus: EventBus;
}): { runtimeApi: RuntimeApi; emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void } {
  return {
    runtimeApi: {
      start: () => input.runtimeApi.start(),
      shutdown: async () => {
        await input.runtimeApi.shutdown();
        input.candidateAvailability.dispose();
        input.eventLogger.close();
        input.errorLogger.close();
      },
      pause: () => input.runtimeApi.pause(),
      resume: () => input.runtimeApi.resume(),
      notifyCard: (cardId, notification) => input.runtimeApi.notifyCard(cardId, notification),
      startProject: (source) => input.runtimeApi.startProject(source),
      stopProject: (source) => input.runtimeApi.stopProject(source),
      subscribe: (options) => input.runtimeApi.subscribe(options),
      getStatus: () => input.runtimeApi.getStatus(),
      getActorRuntimeReadModel: () => input.runtimeApi.getActorRuntimeReadModel(),
    },
    emitAnalystToolInvoked(payload) {
      input.eventBus.emit('analyst_tool_invoked', payload);
    },
  };
}
