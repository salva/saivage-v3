import { EventEmitter as NodeEventEmitter } from 'node:events';
import type { AgentExecutionPort } from '../contracts/index.js';
import { EventBus } from '../events/bus.js';
import type { EventPayload } from '../events/index.js';
import type { LoggedEvent } from '../schemas/index.js';
import type { RuntimeApi } from './runtime-api.js';
import { Runtime } from './runtime.js';
import type { RuntimeConfig, RuntimeControlHooks, RuntimeCoreParts, RuntimeResumeFromFreezeResult, RuntimeTestParts } from './runtime-config.js';
import type { RuntimeDisposeReportEntry } from './lifecycle.js';
import { readRuntimeState } from './state.js';
import type { RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { StuckAgentSupervisor, StuckVerdict } from './stuck-agent-supervisor.js';

function getRuntimeStatus(projectRoot: string, cards: RuntimeCoreParts['cards']): ReturnType<RuntimeApi['getStatus']> {
  const state = readRuntimeState(projectRoot);
  const allCards = cards.list();
  return {
    status: state?.status ?? 'idle',
    paused: state?.paused ?? false,
    currentCardId: state?.current_card_id ?? null,
    goalCount: allCards.filter((card) => card.type === 'goal').length,
    lastTickAt: state?.last_tick_at ?? null,
  };
}

export interface RuntimeCoreContainer {
  api: RuntimeApi;
  projectRoot: string;
  agentEventBus: NodeEventEmitter;
  runtimeLedgerEvents: {
    emit(event: LoggedEvent): void;
    emitAnalystToolInvoked(payload: EventPayload<'analyst_tool_invoked'>): void;
  };
}

export interface RuntimeCoreTestContainer extends RuntimeCoreContainer {
  cardTestTools: Pick<CardStore, 'read' | 'update' | 'create' | 'setStatus'>;
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
  };
  diagnosticTestTools: {
    getBackgroundDispatchCount(): number;
    getLastLifecycleDisposeReport(): RuntimeDisposeReportEntry[];
  };
  lifecycleTestTools: {
    simulateCrash(): Promise<void>;
    performCrashRecovery(): Promise<void>;
    requestImmediateTick(): Promise<void>;
    freeze(reason?: string): import('../schemas/index.js').FreezeManifest;
    resumeFromFreeze(): RuntimeResumeFromFreezeResult;
    consumeResumeHandoffContext(): string | null;
    emitAgentEvent(name: string, data: Record<string, unknown>): void;
  };
}

export function createRuntimeCoreContainer(input: {
  config: RuntimeConfig;
  agentRuntime?: AgentExecutionPort;
  getActivityStatus?: RuntimeApi['getActivityStatus'];
  goalDispatcher?: RuntimeConfig['goalDispatcher'];
}): RuntimeCoreContainer {
  let emitAgentEvent: ((name: string, data: Record<string, unknown>) => void) | null = null;
  let runtimeControls: RuntimeControlHooks | null = null;
  let runtimeCoreParts: RuntimeCoreParts | undefined;
  const agentEventBus = new NodeEventEmitter();
  const emitOnAgentEventBus = agentEventBus.emit.bind(agentEventBus);
  agentEventBus.emit = (eventName: string | symbol, ...args: unknown[]): boolean => {
    const emitted = emitOnAgentEventBus(eventName, ...args);
    if (typeof eventName === 'string') {
      const data = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : { raw: args[0] };
      emitAgentEvent?.(eventName, data);
    }
    return emitted;
  };
  new Runtime(
    {
      ...input.config,
      ...(input.goalDispatcher ? { goalDispatcher: input.goalDispatcher } : {}),
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
    },
    input.agentRuntime,
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
    subscribe: (options) => coreParts.eventBus.subscribe(options),
    getStatus: () => getRuntimeStatus(input.config.projectRoot, coreParts.cards),
    getActivityStatus: input.getActivityStatus ?? (() => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() })),
  };
  return {
    api,
    projectRoot: input.config.projectRoot,
    agentEventBus,
    runtimeLedgerEvents: {
      emit: (event) => coreParts.eventBus.emit(event),
      emitAnalystToolInvoked: (payload) => coreParts.eventBus.emit('analyst_tool_invoked', payload),
    },
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
  let simulateCrash: (() => Promise<void>) | null = null;
  let performCrashRecovery: (() => Promise<void>) | null = null;
  let requestImmediateTick: (() => Promise<void>) | null = null;
  let freeze: ((reason?: string) => import('../schemas/index.js').FreezeManifest) | null = null;
  let resumeFromFreeze: (() => RuntimeResumeFromFreezeResult) | null = null;
  let consumeResumeHandoffContext: (() => string | null) | null = null;
  let emitAgentEvent: ((name: string, data: Record<string, unknown>) => void) | null = null;
  let dispatchGoal: ((goalId: string) => Promise<void>) | null = null;
  let runtimeControls: RuntimeControlHooks | null = null;
  let onRuntimeEvent: ((eventName: string | symbol, listener: (...args: unknown[]) => void) => void) | null = null;
  let runtimeCoreParts: RuntimeCoreParts | undefined;
  let runtimeTestParts: RuntimeTestParts | undefined;
  const agentEventBus = new NodeEventEmitter();
  const emitOnAgentEventBus = agentEventBus.emit.bind(agentEventBus);
  agentEventBus.emit = (eventName: string | symbol, ...args: unknown[]): boolean => {
    const emitted = emitOnAgentEventBus(eventName, ...args);
    if (typeof eventName === 'string') {
      const data = args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, unknown>) : { raw: args[0] };
      emitAgentEvent?.(eventName, data);
    }
    return emitted;
  };
  const runtime = new Runtime(
    {
      ...input.config,
      ...(input.goalDispatcher ? { goalDispatcher: input.goalDispatcher } : {}),
      diagnosticsSink: {
        setBackgroundDispatchCount: (count) => {
          backgroundDispatchCount = count;
        },
        setLastLifecycleDisposeReport: (report) => {
          lastLifecycleDisposeReport = [...report];
        },
      },
      lifecycleTestToolsSink: {
        setSimulateCrash: (nextSimulateCrash) => {
          simulateCrash = nextSimulateCrash;
        },
        setPerformCrashRecovery: (nextPerformCrashRecovery) => {
          performCrashRecovery = nextPerformCrashRecovery;
        },
        setRequestImmediateTick: (nextRequestImmediateTick) => {
          requestImmediateTick = nextRequestImmediateTick;
        },
        setFreeze: (nextFreeze) => {
          freeze = nextFreeze;
        },
        setResumeFromFreeze: (nextResumeFromFreeze) => {
          resumeFromFreeze = nextResumeFromFreeze;
        },
        setConsumeResumeHandoffContext: (nextConsumeResumeHandoffContext) => {
          consumeResumeHandoffContext = nextConsumeResumeHandoffContext;
        },
        setEmitAgentEvent: (nextEmitAgentEvent) => {
          emitAgentEvent = nextEmitAgentEvent;
        },
      },
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
      controlSink: {
        setRuntimeControls: (nextRuntimeControls) => {
          runtimeControls = nextRuntimeControls;
        },
      },
      eventListenerSink: {
        setRuntimeEventListener: (nextOnRuntimeEvent) => {
          onRuntimeEvent = nextOnRuntimeEvent;
        },
      },
    },
    input.agentRuntime,
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
    subscribe: (options) => runtimeParts.eventBus.subscribe(options),
    getStatus: () => getRuntimeStatus(input.config.projectRoot, runtimeParts.cards),
    getActivityStatus: input.getActivityStatus ?? (() => ({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() })),
  };
  return {
    api,
    projectRoot: input.config.projectRoot,
    agentEventBus,
    runtimeLedgerEvents: {
      emit: (event) => runtimeParts.eventBus.emit(event),
      emitAnalystToolInvoked: (payload) => runtimeParts.eventBus.emit('analyst_tool_invoked', payload),
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
      runCheck: () => (runtimeParts.supervisor as unknown as { _runCheck: () => Promise<void> })._runCheck(),
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
    },
    diagnosticTestTools: {
      getBackgroundDispatchCount: () => backgroundDispatchCount,
      getLastLifecycleDisposeReport: () => [...lastLifecycleDisposeReport],
    },
    lifecycleTestTools: {
      simulateCrash: () => {
        if (!simulateCrash) throw new Error('Runtime crash simulation hook is unavailable.');
        return simulateCrash();
      },
      performCrashRecovery: () => {
        if (!performCrashRecovery) throw new Error('Runtime crash recovery hook is unavailable.');
        return performCrashRecovery();
      },
      requestImmediateTick: () => {
        if (!requestImmediateTick) throw new Error('Runtime immediate tick hook is unavailable.');
        return requestImmediateTick();
      },
      freeze: (reason) => {
        if (!freeze) throw new Error('Runtime freeze hook is unavailable.');
        return freeze(reason);
      },
      resumeFromFreeze: () => {
        if (!resumeFromFreeze) throw new Error('Runtime resume-from-freeze hook is unavailable.');
        return resumeFromFreeze();
      },
      consumeResumeHandoffContext: () => {
        if (!consumeResumeHandoffContext) throw new Error('Runtime resume handoff context hook is unavailable.');
        return consumeResumeHandoffContext();
      },
      emitAgentEvent: (name, data) => {
        if (!emitAgentEvent) throw new Error('Runtime agent event hook is unavailable.');
        emitAgentEvent(name, data);
      },
    },
  };
}
