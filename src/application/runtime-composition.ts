import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaivageConfig } from '../agents/config-api.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { FsCandidateAvailability } from '../agents/candidate-availability-store.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import { AnalystRuntime, type AnalystRuntimeDeps } from '../agents/analyst-api.js';
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
import { ProcessRunner } from '../runtime/process-runner.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { ReadModelChanges } from './read-model-changes.js';
import { createProviderExchangeMutationPort } from '../persistence/provider-exchange-mutation-port.js';
import { createConversationMutationPort, type ConversationMutationPort } from '../persistence/conversation-mutation-port.js';

export interface RuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore;
  invocationService: InvocationService;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate: RuntimeGate;
  mcpManagerProvider?: () => McpManager | undefined;
  conversations: ConversationMutationPort;
  readModelChanges: ReadModelChanges;
}

type DisposableCandidateAvailability = CandidateAvailability & { dispose(): void };

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardStore;
  readonly processRunner: ProcessRunner;
  readonly analystDeps: AnalystRuntimeDeps;
  readonly analystRuntime: AnalystRuntime;
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
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
  readModelChanges: ReadModelChanges;
}

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  cardStore: CardStore;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  eventBus: EventBus;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  invocationService: InvocationService;
  processRunner: ProcessRunner;
  mcpManager?: McpManager;
  conversations: ConversationMutationPort;
}): AnalystRuntimeDeps {
  return {
    runtime: input.runtimeApi,
    cardStore: input.cardStore,
    candidateAvailability: input.candidateAvailability,
    eventLogger: input.eventLogger,
    eventBus: input.eventBus,
    emitAnalystToolInvoked: input.emitAnalystToolInvoked,
    provider: createInvocationServiceProvider(input.invocationService),
    processRunner: input.processRunner,
    mcpManager: input.mcpManager,
    conversations: input.conversations,
  };
}

function bundledPromptDefaultsRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourceTreeRoot = join(moduleDir, '..', 'prompts');
  if (existsSync(sourceTreeRoot)) return sourceTreeRoot;
  return join(moduleDir, '..', '..', 'prompts');
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const { projectRoot, config, eventBus, eventLogger, errorLogger, cardStore, restartServerAvailable = false, restartPort } = services;
  const candidateAvailability = new FsCandidateAvailability(projectRoot, {
    compactBytes: config.runtime.candidateAvailabilityCompactBytes,
  });
  const conversations = createConversationMutationPort(projectRoot, services.readModelChanges);
  let mcpManager: McpManager | undefined;

  const registry = new ProviderRegistry(config);
  const router = new ModelRouter(
    config,
    registry,
  );
  const invocationService = new InvocationService({
    projectRoot,
    saivageDir: `${projectRoot}/.saivage`,
    registry,
    router,
    eventLogger,
    candidateAvailability,
    providerExchangeMutations: createProviderExchangeMutationPort(projectRoot, services.readModelChanges),
  });
  const processRunner = new ProcessRunner(projectRoot);
  const runtimeGate = new RuntimeGate();
  const promptTemplates = createPromptTemplateRegistry({
    defaultRoot: bundledPromptDefaultsRoot(),
    overrideRoot: join(projectRoot, '.saivage', 'config', 'prompts'),
  });

  const runtimeFactory = services.runtimeApiFactory ?? createMicroActorRuntimeApi;
  const runtimeComposition = createComposedRuntimeApi({
    runtimeApi: runtimeFactory({ projectRoot, eventBus, cardStore, invocationService, promptTemplates, config, processRunner, runtimeGate, mcpManagerProvider: () => mcpManager, conversations, readModelChanges: services.readModelChanges }),
    candidateAvailability,
    eventLogger,
    errorLogger,
    eventBus,
  });
  const runtimeApi = runtimeComposition.runtimeApi;
  cardStore.setNotifyCard((cardId, notification) => runtimeApi.notifyCard(cardId, notification));
  const emitAnalystToolInvokedFromRuntime = runtimeComposition.emitAnalystToolInvoked;
  let analystDepsCache: AnalystRuntimeDeps | null = null;
  let analystRuntimeCache: AnalystRuntime | null = null;
  const getAnalystDeps = (): AnalystRuntimeDeps => {
    analystDepsCache ??= buildAnalystDeps({
      runtimeApi,
      cardStore,
      candidateAvailability,
      eventLogger,
      eventBus,
      emitAnalystToolInvoked: emitAnalystToolInvokedFromRuntime,
      invocationService,
      processRunner,
      mcpManager,
      conversations,
    });
    return analystDepsCache;
  };

  return {
    runtimeApi,
    cardStore,
    processRunner,
    get analystRuntime() {
      analystRuntimeCache ??= new AnalystRuntime({ projectRoot, config, runtimeDeps: getAnalystDeps(), promptTemplates, restartServerAvailable, restartPort });
      return analystRuntimeCache;
    },
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
      analystRuntimeCache = null;
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
      },
      pause: () => input.runtimeApi.pause(),
      resume: () => input.runtimeApi.resume(),
      notifyCard: (cardId, notification) => input.runtimeApi.notifyCard(cardId, notification),
      startProject: (source) => input.runtimeApi.startProject(source),
      subscribe: (options) => input.runtimeApi.subscribe(options),
      getStatus: () => input.runtimeApi.getStatus(),
      getActorRuntimeReadModel: () => input.runtimeApi.getActorRuntimeReadModel(),
    },
    emitAnalystToolInvoked(payload) {
      input.eventBus.emit('analyst_tool_invoked', payload);
    },
  };
}
