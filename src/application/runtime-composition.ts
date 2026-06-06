import { join } from 'node:path';
import type { SaivageConfig } from '../agents/config-api.js';
import { AgentAdapter } from '../agents/agent-adapter.js';
import { FsCandidateAvailability } from '../agents/candidate-availability-store.js';
import type { CandidateAvailability } from '../agents/candidate-availability.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import type { AnalystRuntimeDeps } from '../agents/analyst-api.js';
import type { EventPayload } from '../events/index.js';
import type { McpManager } from '../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../observability/index.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../runtime/state.js';
import type { RuntimeConfig } from '../runtime/runtime-config.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import { createRuntimeCoreContainer } from '../runtime/core-composition.js';
import { SessionStampCounter } from '../contracts/session-stamper.js';
import { CardStore } from '../cards/card-store.js';

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly cardStore: CardStore;
  readonly analystDeps: AnalystRuntimeDeps;
  setMcpManager(mcpManager: McpManager): void;
}

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  cardStore: CardStore;
  stamper: SessionStampCounter;
  candidateAvailability: CandidateAvailability;
  eventLogger: EventLogger;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  mcpManager?: McpManager;
}): AnalystRuntimeDeps {
  return {
    runtime: input.runtimeApi,
    cardStore: input.cardStore,
    stamper: input.stamper,
    candidateAvailability: input.candidateAvailability,
    eventLogger: input.eventLogger,
    emitAnalystToolInvoked: input.emitAnalystToolInvoked,
    mcpManager: input.mcpManager,
  };
}

export function createRuntimeApplication(projectRoot: string, config: SaivageConfig): RuntimeApplication {
  const saivageDir = join(projectRoot, '.saivage');
  const eventLogger = new EventLogger(saivageDir);
  const errorLogger = new ErrorLogger(saivageDir);
  const skillsEngine = new SkillsEngine({ projectRoot });
  const stamper = new SessionStampCounter();
  // Application-level CardStore backs operator/API/read-model surfaces outside dispatch.
  const cardStore = new CardStore(projectRoot);
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
    activationLedger: {
      readState: () => readRuntimeState(projectRoot),
      appendRun: (input) => appendRuntimeRun(projectRoot, input),
      upsertActivation: (input) => upsertRuntimeActivation(projectRoot, input),
    },
  });
  agentAdapter.setLlmCallFn(agentAdapter.createLlmCallFn());
  agentAdapter.setSkillsEngine(skillsEngine);

  const runtimeConfig: RuntimeConfig = {
    projectRoot,
    fakeAgentConfig: { mapping: {}, fixtureDir: '' },
    skillsEngine,
    autoDispatchBacklog: false,
    continuousImprovement: config.runtime.continuousImprovement,
    eventLogger,
    errorLogger,
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
  let emitAnalystToolInvoked: ((payload: EventPayload<'analyst_tool_invoked'>) => void) | null = null;

  const runtimeCore = createRuntimeCoreContainer({
    config: runtimeConfig,
    agentRuntime: agentAdapter,
    getActivityStatus: (sessionId) => stamper.getActivityStatus(sessionId),
    wireAgentEventBus: (agentEventBus) => {
      agentAdapter.setEventBus(agentEventBus);
    },
    wireRuntimeLedgerEvents: (runtimeLedgerEvents) => {
      agentAdapter.setRuntimeLedgerEventBus(runtimeLedgerEvents);
    },
    wireAnalystToolInvokedEmitter: (emit) => {
      emitAnalystToolInvoked = emit;
    },
  });
  if (!emitAnalystToolInvoked) throw new Error('Runtime analyst event emitter was not provided.');
  const emitAnalystToolInvokedFromRuntime = (payload: EventPayload<'analyst_tool_invoked'>): void => {
    if (!emitAnalystToolInvoked) throw new Error('Runtime analyst event emitter is unavailable.');
    emitAnalystToolInvoked(payload);
  };
  const runtimeApi: RuntimeApi = {
    ...runtimeCore.api,
    shutdown: async () => {
      await runtimeCore.api.shutdown();
      candidateAvailability.dispose();
      eventLogger.close();
      errorLogger.close();
    },
  };

  return {
    runtimeApi,
    cardStore,
    get analystDeps() {
      return buildAnalystDeps({ runtimeApi, cardStore, stamper, candidateAvailability, eventLogger, emitAnalystToolInvoked: emitAnalystToolInvokedFromRuntime, mcpManager });
    },
    setMcpManager(nextMcpManager) {
      mcpManager = nextMcpManager;
      agentAdapter.setMcpManager(nextMcpManager);
      nextMcpManager.setEventLogger(eventLogger);
    },
  };
}
