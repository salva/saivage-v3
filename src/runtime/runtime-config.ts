import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { EventBus } from '../events/index.js';
import type { EventLogger, ErrorLogger } from '../observability/index.js';
import type { SessionActivity, SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import type { StuckAgentSupervisor, SupervisorConfig } from './stuck-agent-supervisor.js';
import type { FreezeManifest } from '../schemas/index.js';
import type { RuntimeApi } from './runtime-api.js';

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

export type RuntimeStampSource = SessionStamper & {
  getActivityStatus(sessionId: string): SessionActivity;
};

export interface RuntimeResumeFromFreezeResult {
  freeze_id: string;
  restored_queue: string[];
  restored_processes: string[];
  restored_card_id: string | null;
}

export type RuntimeControlHooks = Pick<RuntimeApi, 'start' | 'shutdown' | 'pause' | 'resume' | 'startProject' | 'stopProject'>;

export interface RuntimeCoreParts {
  eventBus: EventBus;
  cards: CardStore;
}

export interface RuntimeTestParts {
  agentRuntime: AgentExecutionPort;
  errorLogger: ErrorLogger;
  eventLogger: EventLogger;
  supervisor: StuckAgentSupervisor;
}

export interface RuntimeCompositionHooks {
  diagnosticsSink?: {
    setBackgroundDispatchCount(count: number): void;
    setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void;
  };
  lifecycleTestToolsSink?: {
    setSimulateCrash(simulateCrash: () => Promise<void>): void;
    setPerformCrashRecovery(performCrashRecovery: () => Promise<void>): void;
    setRequestImmediateTick(requestImmediateTick: () => Promise<void>): void;
    setFreeze(freeze: (reason?: string) => FreezeManifest): void;
    setResumeFromFreeze(resumeFromFreeze: () => RuntimeResumeFromFreezeResult): void;
    setConsumeResumeHandoffContext(consumeResumeHandoffContext: () => string | null): void;
  };
  agentEventSink?: {
    setEmitAgentEvent(emitAgentEvent: (name: string, data: Record<string, unknown>) => void): void;
  };
  corePartsSink?: {
    setRuntimeCoreParts(parts: RuntimeCoreParts): void;
  };
  testPartsSink?: {
    setRuntimeTestParts(parts: RuntimeTestParts): void;
  };
  schedulerSink?: {
    setDispatchGoal(dispatchGoal: (goalId: string) => Promise<void>): void;
  };
  controlSink?: {
    setRuntimeControls(controls: RuntimeControlHooks): void;
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
  sessionStamper?: RuntimeStampSource;
  maxGoalDepth?: number;
  supervisorConfig?: Partial<SupervisorConfig>;
  autoDispatchBacklog?: boolean;
  continuousImprovement?: boolean;
  goalDispatcher?: (goalId: string, dispatch: (goalId: string) => Promise<void>) => Promise<void>;
}
