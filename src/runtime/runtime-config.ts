import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { EventLogger, ErrorLogger } from '../observability/index.js';
import type { SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import type { StuckAgentSupervisor, SupervisorConfig } from './stuck-agent-supervisor.js';
import type { RuntimeApi } from './runtime-api.js';
import type { EventPayload } from '../events/index.js';
import type { LoggedEvent } from '../schemas/index.js';

export interface RuntimeSkillsPort {
  loadPlannerInstructions(filePath?: string): Promise<string>;
  loadInstructions(role: string): Promise<string>;
  selectAndFormat(input: {
    goalDescription?: string;
    cardDescription?: string;
    tags?: string[];
    filePaths?: string[];
    availableTools?: string[];
    targetRole?: string;
  }): Promise<string>;
}

export type RuntimeControlHooks = Pick<RuntimeApi, 'start' | 'shutdown' | 'pause' | 'resume' | 'startProject' | 'stopProject'>;

export interface RuntimeCoreParts {
  subscribe: RuntimeApi['subscribe'];
  publishRuntimeLedgerEvent(event: LoggedEvent): void;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  countGoals(): number;
}

export interface RuntimeTestParts {
  cards: Pick<CardStore, 'read' | 'update' | 'create' | 'setStatus'>;
  agentRuntime: AgentExecutionPort;
  errorLogger: ErrorLogger;
  eventLogger: EventLogger;
  supervisor: StuckAgentSupervisor;
}

export interface RuntimeCompositionHooks {
  agentEventSink?: {
    setEmitAgentEvent(emitAgentEvent: (name: string, data: Record<string, unknown>) => void): void;
  };
  corePartsSink?: {
    setRuntimeCoreParts(parts: RuntimeCoreParts): void;
  };
  controlSink?: {
    setRuntimeControls(controls: RuntimeControlHooks): void;
  };
}

export interface RuntimeTestHooks {
  diagnosticsSink?: {
    setBackgroundDispatchCount(count: number): void;
    setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void;
  };
  lifecycleTestToolsSink?: {
    setPerformCrashRecovery(performCrashRecovery: () => Promise<void>): void;
    setRequestImmediateTick(requestImmediateTick: () => Promise<void>): void;
  };
  testPartsSink?: {
    setRuntimeTestParts(parts: RuntimeTestParts): void;
  };
  schedulerSink?: {
    setDispatchGoal(dispatchGoal: (goalId: string) => Promise<void>): void;
  };
  eventListenerSink?: {
    setRuntimeEventListener(on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => void): void;
  };
}

export interface RuntimeConfig {
  projectRoot: string;
  fakeAgentConfig: {
    mapping: Record<string, string>;
    fixtureDir: string;
    saivageDir?: string;
    autoActivateCreatedCards?: boolean;
  };
  agentExecutionFactory?: (
    projectRoot: string,
    fakeAgentConfig: RuntimeConfig['fakeAgentConfig'],
    activationLedger: RuntimeActivationLedgerPort,
  ) => AgentExecutionPort;
  skillsEngine?: RuntimeSkillsPort;
  eventLogger?: EventLogger;
  errorLogger?: ErrorLogger;
  sessionStamper?: SessionStamper;
  maxGoalDepth?: number;
  supervisorConfig?: Partial<SupervisorConfig>;
  autoDispatchBacklog?: boolean;
  continuousImprovement?: boolean;
  goalDispatcher?: (goalId: string, dispatch: (goalId: string) => Promise<void>) => Promise<void>;
}
