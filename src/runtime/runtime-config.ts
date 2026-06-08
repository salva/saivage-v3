import type { AgentExecutionPort, RuntimeActivationLedgerPort } from '../contracts/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { EventLogger, ErrorLogger } from '../observability/index.js';
import type { SessionStamper } from './session-stamper.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import type { StuckAgentSupervisor, SupervisorConfig } from './stuck-agent-supervisor.js';
import type { RuntimeApi } from './runtime-api.js';
import type { EventKind, EventPayload } from '../events/index.js';
import type { EventBus } from '../events/index.js';

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

export type RuntimeControls = Pick<RuntimeApi, 'start' | 'shutdown' | 'pause' | 'resume' | 'startProject' | 'stopProject'>;

export interface RuntimeCoreParts {
  subscribe: RuntimeApi['subscribe'];
  publishRuntimeLedgerEvent<K extends EventKind>(kind: K, payload: EventPayload<K>): void;
  emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  countGoals(): number;
}

export type RuntimeCardTestStore = Pick<CardStore, 'read' | 'update' | 'create' | 'setStatus' | 'repairTerminalLifecycle'>;

export interface RuntimeTestParts {
  cards: RuntimeCardTestStore;
  agentRuntime: AgentExecutionPort;
  errorLogger: ErrorLogger;
  eventLogger: EventLogger;
  supervisor: StuckAgentSupervisor;
}

export interface RuntimeDiagnosticsObserver {
  setBackgroundDispatchCount(count: number): void;
  setLastLifecycleDisposeReport(report: RuntimeDisposeReportEntry[]): void;
}

export interface RuntimeTestAssemblyParts extends RuntimeTestParts {
  dispatchGoal(goalId: string): Promise<void>;
  onRuntimeEvent(eventName: string | symbol, listener: (...args: unknown[]) => void): void;
  performCrashRecovery(): Promise<void>;
  requestImmediateTick(): Promise<void>;
}

export interface RuntimeAssembly {
  controls: RuntimeControls;
  coreParts: RuntimeCoreParts;
  emitAgentEvent(name: string, data: Record<string, unknown>): void;
  testParts?: RuntimeTestAssemblyParts;
}

export interface RuntimeConfig {
  projectRoot: string;
  fakeAgentConfig: {
    mapping: Record<string, string>;
    fixtureDir: string;
    saivageDir?: string;
  };
  skillsEngine?: RuntimeSkillsPort;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  eventBus: EventBus;
  cardStore: CardStore;
  sessionStamper?: SessionStamper;
  maxGoalDepth?: number;
  supervisorConfig?: Partial<SupervisorConfig>;
  autoDispatchBacklog?: boolean;
  continuousImprovement?: boolean;
  goalDispatcher?: (goalId: string, dispatch: (goalId: string) => Promise<void>) => Promise<void>;
}
