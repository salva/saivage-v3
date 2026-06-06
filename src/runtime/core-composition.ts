import { EventEmitter as NodeEventEmitter } from 'node:events';
import type { AgentExecutionPort } from '../contracts/index.js';
import { EventBus } from '../events/bus.js';
import type { EventPayload } from '../events/index.js';
import type { LoggedEvent } from '../schemas/index.js';
import type { RuntimeApi } from './runtime-api.js';
import { initializeRuntimeImplementation } from './runtime.js';
import type { RuntimeCompositionHooks, RuntimeConfig, RuntimeControlHooks, RuntimeCoreParts, RuntimeTestHooks, RuntimeTestParts } from './runtime-config.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import { readRuntimeState } from './state.js';
import type { RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { StuckAgentSupervisor, StuckVerdict } from './stuck-agent-supervisor.js';
import { deriveCurrentCardId } from './current-run.js';

type EmitAgentEvent = (name: string, data: Record<string, unknown>) => void;

function createAgentEventBus(getEmitAgentEvent: () => EmitAgentEvent | null): NodeEventEmitter {
  const agentEventBus = new NodeEventEmitter();
  const emitOnAgentEventBus = agentEventBus.emit.bind(agentEventBus);
  agentEventBus.emit = (eventName: string | symbol, ...args: unknown[]): boolean => {
    const emitted = emitOnAgentEventBus(eventName, ...args);
    if (typeof eventName === 'string') {
      const data = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : { raw: args[0] };
      getEmitAgentEvent()?.(eventName, data);
    }
    return emitted;
  };
  return agentEventBus;
}

function getRuntimeStatus(projectRoot: string, coreParts: RuntimeCoreParts): ReturnType<RuntimeApi['getStatus']> {
  const state = readRuntimeState(projectRoot);
  return {
    status: state?.status ?? 'idle',
    paused: state?.paused ?? false,
    currentCardId: deriveCurrentCardId(state),
    goalCount: coreParts.countGoals(),
    lastTickAt: state?.last_tick_at ?? null,
  };
}

export interface RuntimeCoreContainer {
  api: RuntimeApi;
  projectRoot: string;
}

export interface RuntimeCoreTestContainer extends RuntimeCoreContainer {
  agentEventBus: NodeEventEmitter;
  runtimeLedgerEvents: {
    emit(event: LoggedEvent): void;
    emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  };
  cardTestTools: Pick<CardStore, 'read' | 'update' | 'create' | 'setStatus' | 'repairTerminalLifecycle'>;
  loggerTestTools: {
    isSameErrorLogger(errorLogger: ErrorLogger): boolean;
    appendError(input: Parameters<ErrorLogger['appendError']>[0]): void;
    flushErrors(): void;
    getErrors(): ReturnType<ErrorLogger['getErrors']>;
    getErrorsPath(): string;
    closeErrorLogger(): void;
    flushEvents(): void;
    getEvents(): ReturnType<EventLogger['getEvents']>;
  };
  agentRuntimeTestTools: {
    isSameAgentRuntime(agentRuntime: AgentExecutionPort): boolean;
    getConstructorName(): string;
    cancelSession(sessionId: string): boolean | Promise<boolean>;
    forceCancelSession(sessionId: string): boolean | Promise<boolean>;
  };
  supervisorTestTools: {
    isRunning(): boolean;
    start(): void;
    stop(): void;
    setChecksProvider(provider: () => Promise<StuckVerdict>): void;
    runCheck(): Promise<void>;
  };
  stateTestTools: {
    read(): RuntimeState | null;
  };
  dispatchTestTools: {
    dispatchGoal(goalId: string): Promise<void>;
  };
  eventTestTools: {
    on(eventName: string | symbol, listener: (...args: unknown[]) => void): void;
    emitAgentEvent(name: string, data: Record<string, unknown>): void;
  };
  diagnosticTestTools: {
    getBackgroundDispatchCount(): number;
    getLastLifecycleDisposeReport(): RuntimeDisposeReportEntry[];
  };
  lifecycleTestTools: {
    performCrashRecovery(): Promise<void>;
    requestImmediateTick(): Promise<void>;
  };
}

export function createRuntimeCoreContainer(input: {
  config: RuntimeConfig;
  agentRuntime?: AgentExecutionPort;
  getActivityStatus?: RuntimeApi['getActivityStatus'];
  goalDispatcher?: RuntimeConfig['goalDispatcher'];
  wireAgentEventBus?: (agentEventBus: NodeEventEmitter) => void;
  wireRuntimeLedgerEvents?: (runtimeLedgerEvents: { emit(event: LoggedEvent): void }) => void;
  wireAnalystToolInvokedEmitter?: (emitAnalystToolInvoked: (payload: EventPayload<'analyst_tool_invoked'>) => void) => void;
}): RuntimeCoreContainer {
  let emitAgentEvent: EmitAgentEvent | null = null;
  let runtimeControls: RuntimeControlHooks | null = null;
  let runtimeCoreParts: RuntimeCoreParts | undefined;
  const agentEventBus = createAgentEventBus(() => emitAgentEvent);
  const productionHooks: RuntimeCompositionHooks = {
    agentEventSink: {
      setEmitAgentEvent: (nextEmitAgentEvent) => {
        emitAgentEvent = nextEmitAgentEvent;
      },
    },
    corePartsSink: {
      setRuntimeCoreParts: (nextCoreParts) => {
        runtimeCoreParts = nextCoreParts;
      },
    },
    controlSink: {
      setRuntimeControls: (nextRuntimeControls) => {
        runtimeControls = nextRuntimeControls;
      },
    },
  };
  initializeRuntimeImplementation(
    {
      ...input.config,
      ...(input.goalDispatcher ? { goalDispatcher: input.goalDispatcher } : {}),
    },
    input.agentRuntime,
    productionHooks,
  );
  if (!runtimeCoreParts) throw new Error('Runtime core parts were not provided during core composition.');
  const controls = runtimeControls as RuntimeControlHooks | null;
  if (!controls) throw new Error('Runtime controls were not provided during core composition.');
  const coreParts = runtimeCoreParts;
  const api: RuntimeApi = {
    start: () => controls.start(),
    shutdown: () => controls.shutdown(),
    pause: () => controls.pause(),
    resume: () => controls.resume(),
    startProject: (source) => controls.startProject(source),
    stopProject: (source) => controls.stopProject(source),
    subscribe: (options) => coreParts.subscribe(options),
    getStatus: () => getRuntimeStatus(input.config.projectRoot, coreParts),
    getActivityStatus: input.getActivityStatus ?? (() => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() })),
  };
  const runtimeLedgerEvents = {
    emit: (event: LoggedEvent) => coreParts.publishRuntimeLedgerEvent(event),
  };
  const emitAnalystToolInvoked = (payload: EventPayload<'analyst_tool_invoked'>) =>
    coreParts.emitAnalystToolInvoked(payload);
  input.wireAgentEventBus?.(agentEventBus);
  input.wireRuntimeLedgerEvents?.(runtimeLedgerEvents);
  input.wireAnalystToolInvokedEmitter?.(emitAnalystToolInvoked);
  return {
    api,
    projectRoot: input.config.projectRoot,
  };
}

export function createRuntimeCoreTestContainer(input: {
  config: RuntimeConfig;
  agentRuntime?: AgentExecutionPort;
  getActivityStatus?: RuntimeApi['getActivityStatus'];
  goalDispatcher?: RuntimeConfig['goalDispatcher'];
}): RuntimeCoreTestContainer {
  let backgroundDispatchCount = 0;
  let lastLifecycleDisposeReport: RuntimeDisposeReportEntry[] = [];
  let performCrashRecovery: (() => Promise<void>) | null = null;
  let requestImmediateTick: (() => Promise<void>) | null = null;
  let emitAgentEvent: EmitAgentEvent | null = null;
  let dispatchGoal: ((goalId: string) => Promise<void>) | null = null;
  let runtimeControls: RuntimeControlHooks | null = null;
  let onRuntimeEvent: ((eventName: string | symbol, listener: (...args: unknown[]) => void) => void) | null = null;
  let runtimeCoreParts: RuntimeCoreParts | undefined;
  let runtimeTestParts: RuntimeTestParts | undefined;
  const agentEventBus = createAgentEventBus(() => emitAgentEvent);
  const productionHooks: RuntimeCompositionHooks = {
    agentEventSink: {
      setEmitAgentEvent: (nextEmitAgentEvent) => {
        emitAgentEvent = nextEmitAgentEvent;
      },
    },
    corePartsSink: {
      setRuntimeCoreParts: (nextCoreParts) => {
        runtimeCoreParts = nextCoreParts;
      },
    },
    controlSink: {
      setRuntimeControls: (nextRuntimeControls) => {
        runtimeControls = nextRuntimeControls;
      },
    },
  };
  const testHooks: RuntimeTestHooks = {
    diagnosticsSink: {
      setBackgroundDispatchCount: (count) => {
        backgroundDispatchCount = count;
      },
      setLastLifecycleDisposeReport: (report) => {
        lastLifecycleDisposeReport = [...report];
      },
    },
    lifecycleTestToolsSink: {
      setPerformCrashRecovery: (nextPerformCrashRecovery) => {
        performCrashRecovery = nextPerformCrashRecovery;
      },
      setRequestImmediateTick: (nextRequestImmediateTick) => {
        requestImmediateTick = nextRequestImmediateTick;
      },
    },
    testPartsSink: {
      setRuntimeTestParts: (nextTestParts) => {
        runtimeTestParts = nextTestParts;
      },
    },
    schedulerSink: {
      setDispatchGoal: (nextDispatchGoal) => {
        dispatchGoal = nextDispatchGoal;
      },
    },
    eventListenerSink: {
      setRuntimeEventListener: (nextOnRuntimeEvent) => {
        onRuntimeEvent = nextOnRuntimeEvent;
      },
    },
  };
  initializeRuntimeImplementation(
    {
      ...input.config,
      ...(input.goalDispatcher ? { goalDispatcher: input.goalDispatcher } : {}),
    },
    input.agentRuntime,
    productionHooks,
    testHooks,
  );
  if (!runtimeCoreParts) throw new Error('Runtime core parts were not provided during core composition.');
  if (!runtimeTestParts) throw new Error('Runtime test parts were not provided during test core composition.');
  const controls = runtimeControls as RuntimeControlHooks | null;
  if (!controls) throw new Error('Runtime controls were not provided during core composition.');
  const addRuntimeEventListener = onRuntimeEvent as ((eventName: string | symbol, listener: (...args: unknown[]) => void) => void) | null;
  if (!addRuntimeEventListener) throw new Error('Runtime event listener hook was not provided during core composition.');
  const runtimeParts = { ...runtimeCoreParts, ...runtimeTestParts };
  const api: RuntimeApi = {
    start: () => controls.start(),
    shutdown: () => controls.shutdown(),
    pause: () => controls.pause(),
    resume: () => controls.resume(),
    startProject: (source) => controls.startProject(source),
    stopProject: (source) => controls.stopProject(source),
    subscribe: (options) => runtimeParts.subscribe(options),
    getStatus: () => getRuntimeStatus(input.config.projectRoot, runtimeParts),
    getActivityStatus: input.getActivityStatus ?? (() => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() })),
  };
  return {
    api,
    projectRoot: input.config.projectRoot,
    agentEventBus,
    runtimeLedgerEvents: {
      emit: (event) => runtimeParts.publishRuntimeLedgerEvent(event),
      emitAnalystToolInvoked: (payload) => runtimeParts.emitAnalystToolInvoked(payload),
    },
    cardTestTools: runtimeParts.cards,
    agentRuntimeTestTools: {
      isSameAgentRuntime: (agentRuntime) => runtimeParts.agentRuntime === agentRuntime,
      getConstructorName: () => runtimeParts.agentRuntime.constructor.name,
      cancelSession: (sessionId) => runtimeParts.agentRuntime.cancelSession(sessionId),
      forceCancelSession: (sessionId) => runtimeParts.agentRuntime.forceCancelSession(sessionId),
    },
    loggerTestTools: {
      isSameErrorLogger: (errorLogger) => runtimeParts.errorLogger === errorLogger,
      appendError: (input) => runtimeParts.errorLogger.appendError(input),
      flushErrors: () => runtimeParts.errorLogger.flushSync(),
      getErrors: () => runtimeParts.errorLogger.getErrors(),
      getErrorsPath: () => runtimeParts.errorLogger.getErrorsPath(),
      closeErrorLogger: () => runtimeParts.errorLogger.close(),
      flushEvents: () => runtimeParts.eventLogger.flushSync(),
      getEvents: () => runtimeParts.eventLogger.getEvents(),
    },
    supervisorTestTools: {
      isRunning: () => runtimeParts.supervisor.running,
      start: () => runtimeParts.supervisor.start(),
      stop: () => runtimeParts.supervisor.stop(),
      setChecksProvider: (provider) => runtimeParts.supervisor.setChecksProvider(provider),
      runCheck: () => runtimeParts.supervisor.runCheck(),
    },
    stateTestTools: {
      read: () => readRuntimeState(input.config.projectRoot),
    },
    dispatchTestTools: {
      dispatchGoal: (goalId) => {
        if (!dispatchGoal) throw new Error('Runtime dispatchGoal hook is unavailable.');
        return dispatchGoal(goalId);
      },
    },
    eventTestTools: {
      on: (eventName, listener) => {
        addRuntimeEventListener(eventName, listener);
      },
      emitAgentEvent: (name, data) => {
        if (!emitAgentEvent) throw new Error('Runtime agent event hook is unavailable.');
        emitAgentEvent(name, data);
      },
    },
    diagnosticTestTools: {
      getBackgroundDispatchCount: () => backgroundDispatchCount,
      getLastLifecycleDisposeReport: () => [...lastLifecycleDisposeReport],
    },
    lifecycleTestTools: {
      performCrashRecovery: () => {
        if (!performCrashRecovery) throw new Error('Runtime crash recovery hook is unavailable.');
        return performCrashRecovery();
      },
      requestImmediateTick: () => {
        if (!requestImmediateTick) throw new Error('Runtime immediate tick hook is unavailable.');
        return requestImmediateTick();
      },
    },
  };
}
