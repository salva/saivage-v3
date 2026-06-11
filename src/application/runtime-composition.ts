import { join } from 'node:path';
import type { SaivageConfig } from '../agents/config-api.js';
import { AgentAdapter } from '../agents/agent-adapter.js';
import { buildProviderRoutingReadModel, type ProviderRoutingReadModel } from '../agents/provider-routing-read-model.js';
import { FsCandidateAvailability } from '../agents/candidate-availability-store.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import { ContextCompactor } from '../agents/context-compactor.js';
import type { AnalystRuntimeDeps } from '../agents/analyst-api.js';
import type { EventPayload } from '../events/index.js';
import type { EventBus } from '../events/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../observability/index.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../runtime/state.js';
import type { RuntimeConfig } from '../runtime/runtime-config.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import { createRuntimeCoreContainer } from '../runtime/core-composition.js';
import { SessionStampCounter } from '../runtime/session-stamp-counter.js';
import { CardStore } from '../cards/card-store.js';
import type { InvocationService } from '../agents/invocation-service.js';

export interface RuntimeApiFactoryDeps {
  projectRoot: string;
  eventBus: EventBus;
  cardStore: CardStore;
  invocationService: InvocationService;
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
  stamper: SessionStampCounter;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  eventBus: EventBus;
  contextCompactor: ContextCompactor;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  mcpManager?: McpManager;
}): AnalystRuntimeDeps {
  return {
    runtime: input.runtimeApi,
    cardStore: input.cardStore,
    stamper: input.stamper,
    candidateAvailability: input.candidateAvailability,
    eventLogger: input.eventLogger,
    eventBus: input.eventBus,
    contextCompactor: input.contextCompactor,
    emitAnalystToolInvoked: input.emitAnalystToolInvoked,
    mcpManager: input.mcpManager,
  };
}

export function createRuntimeApplication(services: RuntimeApplicationServices): RuntimeApplication {
  const { projectRoot, config, eventBus, eventLogger, errorLogger, cardStore } = services;
  const saivageDir = join(projectRoot, '.saivage');
  const skillsEngine = new SkillsEngine({ projectRoot });
  const stamper = new SessionStampCounter();
  const contextCompactor = new ContextCompactor({ saivageDir, sessionStamper: stamper });
  const candidateAvailability = new FsCandidateAvailability(projectRoot, {
    compactBytes: config.runtime.candidateAvailabilityCompactBytes,
  });
  let mcpManager: McpManager | undefined;

  const agentAdapter = new AgentAdapter({
    projectRoot,
    saivageDir,
    config,
    eventLogger,
    candidateAvailability,
    cardStore,
    contextCompactor,
    activationLedger: {
      readState: () => readRuntimeState(projectRoot),
      appendRun: (input) => appendRuntimeRun(projectRoot, input),
      upsertActivation: (input) => upsertRuntimeActivation(projectRoot, input),
    },
  });
  agentAdapter.setSkillsEngine(skillsEngine);

  const runtimeConfig: RuntimeConfig = {
    projectRoot,
    fakeAgentConfig: { mapping: {}, fixtureDir: '' },
    skillsEngine,
    autoDispatchBacklog: false,
    continuousImprovement: config.runtime.continuousImprovement,
    eventLogger,
    errorLogger,
    eventBus,
    cardStore,
    sessionStamper: stamper,
    supervisorConfig: config.supervisor
      ? {
          enabled: config.supervisor.enabled,
          intervalMs: config.supervisor.intervalMs,
          consecutiveStuckVerdicts: config.supervisor.consecutiveStuckVerdicts,
          logLines: config.supervisor.logLines,
        }
      : undefined,
  };
  const runtimeComposition = services.runtimeApiFactory
    ? createOptInRuntimeApi({
      runtimeApi: services.runtimeApiFactory({ projectRoot, eventBus, cardStore, invocationService: agentAdapter.getInvocationService() }),
      candidateAvailability,
      eventLogger,
      errorLogger,
    })
    : createDefaultRuntimeApi({
      runtimeConfig,
      agentAdapter,
      stamper,
      candidateAvailability,
      eventLogger,
      errorLogger,
    });
  const runtimeApi = runtimeComposition.runtimeApi;
  const emitAnalystToolInvokedFromRuntime = runtimeComposition.emitAnalystToolInvoked;
  let analystDepsCache: AnalystRuntimeDeps | null = null;
  const getAnalystDeps = (): AnalystRuntimeDeps => {
    analystDepsCache ??= buildAnalystDeps({
      runtimeApi,
      cardStore,
      stamper,
      candidateAvailability,
      eventLogger,
      eventBus,
      contextCompactor,
      emitAnalystToolInvoked: emitAnalystToolInvokedFromRuntime,
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
        registry: agentAdapter.getRegistry(),
        availability: agentAdapter.getCandidateAvailability(),
      });
    },
    setMcpManager(nextMcpManager) {
      mcpManager = nextMcpManager;
      analystDepsCache = null;
      agentAdapter.setMcpManager(nextMcpManager);
      nextMcpManager.setEventLogger(eventLogger);
    },
  };
}

function createDefaultRuntimeApi(input: {
  runtimeConfig: RuntimeConfig;
  agentAdapter: AgentAdapter;
  stamper: SessionStampCounter;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
}): { runtimeApi: RuntimeApi; emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void } {
  let emitAnalystToolInvoked: ((payload: EventPayload<'analyst_tool_invoked'>) => void) | null = null;
  const runtimeCore = createRuntimeCoreContainer({
    config: input.runtimeConfig,
    agentRuntime: input.agentAdapter,
    getActivityStatus: (sessionId) => input.stamper.getActivityStatus(sessionId),
    wireAgentEventBus: (agentEventBus) => {
      input.agentAdapter.setEventBus(agentEventBus);
    },
    wireRuntimeLedgerEvents: (runtimeLedgerEvents) => {
      input.agentAdapter.setRuntimeLedgerEventBus(runtimeLedgerEvents);
    },
    wireAnalystToolInvokedEmitter: (emit) => {
      emitAnalystToolInvoked = emit;
    },
  });
  if (!emitAnalystToolInvoked) throw new Error('Runtime analyst event emitter was not provided.');
  return {
    runtimeApi: {
      ...runtimeCore.api,
      shutdown: async () => {
        await runtimeCore.api.shutdown();
        input.candidateAvailability.dispose();
        input.eventLogger.close();
        input.errorLogger.close();
      },
    },
    emitAnalystToolInvoked(payload) {
      if (!emitAnalystToolInvoked) throw new Error('Runtime analyst event emitter is unavailable.');
      emitAnalystToolInvoked(payload);
    },
  };
}

function createOptInRuntimeApi(input: {
  runtimeApi: RuntimeApi;
  candidateAvailability: DisposableCandidateAvailability;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
}): { runtimeApi: RuntimeApi; emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void } {
  return {
    runtimeApi: {
      ...input.runtimeApi,
      shutdown: async () => {
        await input.runtimeApi.shutdown();
        input.candidateAvailability.dispose();
        input.eventLogger.close();
        input.errorLogger.close();
      },
    },
    emitAnalystToolInvoked() {},
  };
}
