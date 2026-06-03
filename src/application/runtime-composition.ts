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
import { SessionStampCounter, type SessionActivity, type SessionStamper } from '../contracts/session-stamper.js';

export interface RuntimeApplication {
  readonly runtimeApi: RuntimeApi;
  readonly analystDeps: AnalystRuntimeDeps;
  setMcpManager(mcpManager: McpManager): void;
}

type ApplicationSessionStamper = SessionStamper & { getActivityStatus(sessionId: string): SessionActivity };

function buildAnalystDeps(input: {
  runtimeApi: RuntimeApi;
  stamper: ApplicationSessionStamper;
  candidateAvailability: CandidateAvailability;
  eventLogger: EventLogger;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  mcpManager?: McpManager;
}): AnalystRuntimeDeps {
  return {
    runtime: input.runtimeApi,
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

  const runtimeCore = createRuntimeCoreContainer({
    config: runtimeConfig,
    agentRuntime: agentAdapter,
    getActivityStatus: (sessionId) => stamper.getActivityStatus(sessionId),
  });
  agentAdapter.setEventBus(runtimeCore.agentEventBus);
  agentAdapter.setRuntimeLedgerEventBus(runtimeCore.runtimeLedgerEvents);

  const emitAnalystToolInvoked = (payload: EventPayload<'analyst_tool_invoked'>): void => {
    runtimeCore.runtimeLedgerEvents.emitAnalystToolInvoked(payload);
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
    get analystDeps() {
      return buildAnalystDeps({ runtimeApi, stamper, candidateAvailability, eventLogger, emitAnalystToolInvoked, mcpManager });
    },
    setMcpManager(nextMcpManager) {
      mcpManager = nextMcpManager;
      agentAdapter.setMcpManager(nextMcpManager);
      nextMcpManager.setEventLogger(eventLogger);
    },
  };
}
