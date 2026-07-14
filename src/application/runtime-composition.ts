import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaivageConfig } from '../agents/config-api.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { CandidateAvailabilityStore } from '../agents/candidate-availability-store.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import { AnalystRuntime, type AnalystRuntimeDeps } from '../agents/analyst-api.js';
import { ProviderRegistry } from '../agents/provider.js';
import { ModelRouter } from '../agents/model-router.js';
import type { EventPayload } from '../events/index.js';
import type { EventBus } from '../events/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../observability/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';

import { CardStoreRepository } from '../cards/card-store.js';
import { InvocationService } from '../agents/invocation-service.js';
import { createInvocationServiceProvider, createMicroActorRuntimeApi } from './micro-actor-runtime-api-factory.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../runtime/managed-process-group-registry.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { ReadModelChanges } from './read-model-changes.js';
import { ConversationStore } from '../persistence/conversation-store.js';
import type { AppLogStore } from '../persistence/app-log.js';
import type { AuthProfileRepository } from '../auth/auth-profile-store.js';
import type { ApplicationPersistenceHealth } from './persistence-health.js';
import { RuntimeInterventionBinding } from './intervention-readiness.js';
import { RuntimeStateStore } from '../runtime/state.js';
import { ActorSnapshotStore } from '../runtime/actors/snapshots.js';
import { RecoveryDiagnosticsStore } from '../runtime/actors/actor-recovery.js';

export interface RuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStoreRepository;
  persistenceHealth: ApplicationPersistenceHealth;
  interventionBinding: RuntimeInterventionBinding;
  invocationService: InvocationService;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate: RuntimeGate;
  mcpManagerProvider?: () => McpManager | undefined;
  conversations: ConversationStore;
  appLogs: AppLogStore;
  runtimeState: RuntimeStateStore;
  snapshots: ActorSnapshotStore;
  recoveryDiagnostics: RecoveryDiagnosticsStore;
  readModelChanges: ReadModelChanges;
}


export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardStoreRepository;
  readonly processRunner: ProcessRunner;
  readonly analystDeps: AnalystRuntimeDeps;
  readonly analystRuntime: AnalystRuntime;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
  setMcpManager(mcpManager: McpManager): void;
}

export interface RuntimeApplicationServices {
  projectRoot: string;
  config: SaivageConfig;
  configAuthority: ResolvedConfigAuthority;
  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  appLogs: AppLogStore;
  cardStore: CardStoreRepository;
  authProfiles: AuthProfileRepository;
  persistenceHealth: ApplicationPersistenceHealth;
  runtimeApiFactory?: (deps: RuntimeApiFactoryDeps) => RuntimeApi;
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
  readModelChanges: ReadModelChanges;
}

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  cardStore: CardStoreRepository;
  eventLogger: EventLogger;
  eventBus: EventBus;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  invocationService: InvocationService;
  processRunner: ProcessRunner;
  mcpManager?: McpManager;
  conversations: ConversationStore;
  configAuthority: ResolvedConfigAuthority;
  appLogs: AppLogStore;
  persistenceHealth: ApplicationPersistenceHealth;
  interventionReadiness: RuntimeInterventionBinding;
}): AnalystRuntimeDeps {
  return {
    configAuthority: input.configAuthority,
    runtime: input.runtimeApi,
    cardStore: input.cardStore,
    eventLogger: input.eventLogger,
    eventBus: input.eventBus,
    emitAnalystToolInvoked: input.emitAnalystToolInvoked,
    provider: createInvocationServiceProvider(input.invocationService),
    processRunner: input.processRunner,
    analystProcessRootScope: input.processRunner.analystRootScope,
    mcpManager: input.mcpManager,
    conversations: input.conversations,
    appLogs: input.appLogs,
    persistenceHealth: input.persistenceHealth,
    interventionReadiness: input.interventionReadiness,
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
  const interventionBinding = new RuntimeInterventionBinding();
  const candidateAvailability = new CandidateAvailabilityStore(projectRoot, services.persistenceHealth);
  candidateAvailability.restabilize();
  const conversations = new ConversationStore(projectRoot, services.persistenceHealth, services.readModelChanges);
  conversations.restabilize();
  const runtimeState = new RuntimeStateStore(projectRoot, services.persistenceHealth, services.readModelChanges);
  runtimeState.restabilize();
  const initialRuntimeState = runtimeState.initialize();
  if (initialRuntimeState.status === 'stopped') interventionBinding.markStoppedReady();
  const snapshots = new ActorSnapshotStore(projectRoot, services.persistenceHealth, services.readModelChanges);
  snapshots.restabilize();
  const recoveryDiagnostics = new RecoveryDiagnosticsStore(projectRoot, services.persistenceHealth);
  recoveryDiagnostics.restabilize();
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
    appLogs: services.appLogs,
    authProfiles: services.authProfiles,
  });
  const processRegistry = new ManagedProcessGroupRegistry();
  const processRunner = new ProcessRunner(projectRoot, processRegistry);
  const runtimeGate = new RuntimeGate();
  const promptTemplates = createPromptTemplateRegistry({
    defaultRoot: bundledPromptDefaultsRoot(),
    overrideRoot: join(projectRoot, '.saivage', 'config', 'prompts'),
  });

  const runtimeFactory = services.runtimeApiFactory ?? createMicroActorRuntimeApi;
  const runtimeComposition = createComposedRuntimeApi({
    runtimeApi: runtimeFactory({ projectRoot, eventBus, cardStore, persistenceHealth: services.persistenceHealth, interventionBinding, invocationService, promptTemplates, config, processRunner, runtimeGate, mcpManagerProvider: () => mcpManager, conversations, appLogs: services.appLogs, runtimeState, snapshots, recoveryDiagnostics, readModelChanges: services.readModelChanges }),
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
      eventLogger,
      eventBus,
      emitAnalystToolInvoked: emitAnalystToolInvokedFromRuntime,
      invocationService,
      processRunner,
      mcpManager,
      conversations,
      configAuthority: services.configAuthority,
      appLogs: services.appLogs,
      persistenceHealth: services.persistenceHealth,
      interventionReadiness: interventionBinding,
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
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  eventBus: EventBus;
}): { runtimeApi: RuntimeApi; emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void } {
  return {
    runtimeApi: {
      start: () => input.runtimeApi.start(),
      shutdown: async () => {
        await input.runtimeApi.shutdown();
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
