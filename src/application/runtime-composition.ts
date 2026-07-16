import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaivageConfig } from '../agents/config-api.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { MemoryCandidateAvailability } from '../agents/candidate-availability.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import { AnalystRuntime, type AnalystRuntimeDeps } from '../agents/analyst-api.js';
import { ProviderRegistry } from '../agents/provider.js';
import { ModelRouter } from '../agents/model-router.js';
import type { EventPayload } from '../events/index.js';
import type { EventBus } from '../events/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { EventLog, ErrorLog } from '../observability/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';

import { CardService } from '../cards/card-service.js';
import { InvocationService } from '../agents/invocation-service.js';
import { createInvocationServiceProvider, createMicroActorRuntimeApi } from './micro-actor-runtime-api-factory.js';
import { ProcessRunner } from '../runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../runtime/managed-process-group-registry.js';
import { RuntimeGate } from '../runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../utils/prompt-api.js';
import type { RestartPort } from '../boot/restart-port.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { ReadModelChanges } from './read-model-changes.js';
import type { ConversationFileContext } from '../persistence/conversation-file.js';
import type { AppLogContext } from '../persistence/app-log.js';
import { RuntimeInterventionBinding } from './intervention-readiness.js';
import { RuntimeControlService, type RuntimeControlApplicationPort, type RuntimeControlMechanics } from './runtime-control-service.js';

export interface RuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardService;
  interventionBinding: RuntimeInterventionBinding;
  invocationService: InvocationService;
  config?: SaivageConfig;
  processRunner: ProcessRunner;
  runtimeGate: RuntimeGate;
  mcpManagerProvider?: () => McpManager | undefined;
  conversations: ConversationFileContext;
  appLogs: AppLogContext;
  readModelChanges: ReadModelChanges;
}


export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly runtimeControl: RuntimeControlApplicationPort;
  readonly cardStore: CardService;
  readonly processRunner: ProcessRunner;
  readonly analystDeps: AnalystRuntimeDeps;
  readonly analystRuntime: AnalystRuntime;
  closeRuntimeAdmission(): void;
  closeAnalystAdmission(): void;
  cleanupRuntimeForApplicationStop(): Promise<void>;
  cleanupAnalystForApplicationStop(): Promise<void>;
  getProviderRoutingReadModel(): ProviderRoutingReadModel;
  setMcpManager(mcpManager: McpManager): void;
}

export interface RuntimeApplicationServices {
  projectRoot: string;
  config: SaivageConfig;
  configAuthority: ResolvedConfigAuthority;
  eventBus: EventBus;
  eventLogger: EventLog;
  errorLogger: ErrorLog;
  appLogs: AppLogContext;
  cardStore: CardService;
  runtimeApiFactory?: (deps: RuntimeApiFactoryDeps) => RuntimeControlMechanics;
  restartServerAvailable?: boolean;
  restartPort?: RestartPort;
  readModelChanges: ReadModelChanges;
}

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  runtimeControl: RuntimeControlService;
  cardStore: CardService;
  eventLogger: EventLog;
  eventBus: EventBus;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  invocationService: InvocationService;
  processRunner: ProcessRunner;
  mcpManager?: McpManager;
  conversations: ConversationFileContext;
  configAuthority: ResolvedConfigAuthority;
  appLogs: AppLogContext;
  interventionReadiness: RuntimeInterventionBinding;
}): AnalystRuntimeDeps {
  return {
    configAuthority: input.configAuthority,
    runtime: input.runtimeApi,
    runtimeControl: input.runtimeControl,
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
  const candidateAvailability = new MemoryCandidateAvailability();
  const conversations: ConversationFileContext = { projectRoot, changes: services.readModelChanges };
  interventionBinding.markStoppedReady();
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
  });
  const processRegistry = new ManagedProcessGroupRegistry();
  const processRunner = new ProcessRunner(projectRoot, processRegistry);
  const runtimeGate = new RuntimeGate();
  const promptTemplates = createPromptTemplateRegistry({
    defaultRoot: bundledPromptDefaultsRoot(),
    overrideRoot: join(projectRoot, '.saivage', 'config', 'prompts'),
  });

  const runtimeFactory = services.runtimeApiFactory ?? createMicroActorRuntimeApi;
  const runtimeMechanics = runtimeFactory({ projectRoot, eventBus, cardStore, interventionBinding, invocationService, promptTemplates, config, processRunner, runtimeGate, mcpManagerProvider: () => mcpManager, conversations, appLogs: services.appLogs, readModelChanges: services.readModelChanges });
  const runtimeControl = new RuntimeControlService({ projectRoot, interventionBinding, mechanics: runtimeMechanics });
  const runtimeComposition = createComposedRuntimeApi({
    runtimeApi: runtimeControl,
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
      runtimeControl,
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
      interventionReadiness: interventionBinding,
    });
    return analystDepsCache;
  };

  return {
    runtimeApi,
    runtimeControl,
    cardStore,
    processRunner,
    get analystRuntime() {
      analystRuntimeCache ??= new AnalystRuntime({ projectRoot, config, runtimeDeps: getAnalystDeps(), promptTemplates, restartServerAvailable, restartPort });
      return analystRuntimeCache;
    },
    get analystDeps() {
      return getAnalystDeps();
    },
    closeRuntimeAdmission() { runtimeControl.closeApplicationAdmission(); },
    closeAnalystAdmission() { analystRuntimeCache?.closeAdmission(); },
    cleanupRuntimeForApplicationStop() { return runtimeControl.cleanupForApplicationStop(); },
    cleanupAnalystForApplicationStop() { return analystRuntimeCache ? analystRuntimeCache.cleanupForApplicationStop() : Promise.resolve(); },
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
      nextMcpManager.setEventLog(eventLogger);
    },
  };
}

function createComposedRuntimeApi(input: {
  runtimeApi: RuntimeApi;
  eventLogger: EventLog;
  errorLogger: ErrorLog;
  eventBus: EventBus;
}): { runtimeApi: RuntimeApi; emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void } {
  return {
    runtimeApi: {
      start: () => input.runtimeApi.start(),
      pause: () => input.runtimeApi.pause(),
      resume: () => input.runtimeApi.resume(),
      stopProject: () => input.runtimeApi.stopProject(),
      notifyCard: (cardId, notification) => input.runtimeApi.notifyCard(cardId, notification),
      cancelCard: (cardId, reason) => input.runtimeApi.cancelCard(cardId, reason),
      startProject: (source) => input.runtimeApi.startProject(source),
      subscribe: (options) => input.runtimeApi.subscribe(options),
      getStatus: () => input.runtimeApi.getStatus(),
      getRuntimeState: () => input.runtimeApi.getRuntimeState(),
      getActorRuntimeReadModel: () => input.runtimeApi.getActorRuntimeReadModel(),
    },
    emitAnalystToolInvoked(payload) {
      input.eventBus.emit('analyst_tool_invoked', payload);
    },
  };
}
