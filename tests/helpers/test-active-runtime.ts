import { EventBus } from '../../src/events/bus.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import type { AnalystRuntimeDeps } from '../../src/agents/analyst-api.js';
import type { RuntimeApi } from '../../src/runtime/runtime-api.js';
import type { RoundStamp } from '../../src/agents/session-persistence.js';
import { generateRoundId } from '../../src/agents/round-id-server.js';

interface TestRoundState { currentRoundId: string | null; nextMessageIndex: number; nextBlockIndex: number; }

type TestAnalystRuntime = RuntimeApi & AnalystRuntimeDeps['stamper'] & {
  eventLogger?: AnalystRuntimeDeps['eventLogger'];
  candidateAvailability?: AnalystRuntimeDeps['candidateAvailability'];
  mcpManager?: AnalystRuntimeDeps['mcpManager'];
  emitAnalystToolInvoked(payload: Parameters<EventBus['emit']>[1]): void;
  setMcpManager(mcpManager: NonNullable<AnalystRuntimeDeps['mcpManager']>): void;
};

export function createTestActiveRuntime(opts: { eventBus?: EventBus } = {}): TestAnalystRuntime {
  const eventBus = opts.eventBus ?? new EventBus();
  const states = new Map<string, TestRoundState>();
  const stateFor = (sessionId: string): TestRoundState => {
    let state = states.get(sessionId);
    if (!state) {
      state = { currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0 };
      states.set(sessionId, state);
    }
    return state;
  };
  const runtime = {
    runtime: { eventBus, eventLogger: undefined },
    eventLogger: undefined,
    candidateAvailability: undefined,
    mcpManager: undefined as unknown,
    async start(): Promise<void> {},
    async shutdown(): Promise<void> {},
    pause(): void {},
    resume(): void {},
    async startProject(): Promise<{ success: true }> { return { success: true }; },
    async stopProject(): Promise<{ success: true }> { return { success: true }; },
    subscribe: eventBus.subscribe.bind(eventBus),
    getStatus(): { status: 'idle'; paused: false; currentCardId: null; goalCount: 0; lastTickAt: null } { return { status: 'idle', paused: false, currentCardId: null, goalCount: 0, lastTickAt: null }; },
    emitAnalystToolInvoked(payload: Parameters<EventBus['emit']>[1]): void {
      eventBus.emit('analyst_tool_invoked', payload as never);
    },
    setMcpManager(mcpManager: NonNullable<AnalystRuntimeDeps['mcpManager']>): void {
      this.mcpManager = mcpManager;
    },
    openAssistantRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = generateRoundId('assistant');
      state.nextMessageIndex = 0;
      state.nextBlockIndex = 0;
      return this.stampInRound(sessionId);
    },
    stampInRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      if (!state.currentRoundId) state.currentRoundId = generateRoundId('assistant');
      return { round_id: state.currentRoundId, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
    },
    stampUserMessage(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      state.nextBlockIndex = 0;
      return { round_id: generateRoundId('user'), message_index: 0, block_index: 0 };
    },
    stampPre(_sessionId: string): RoundStamp {
      return { round_id: generateRoundId('pre'), message_index: 0, block_index: 0 };
    },
    stampCompacted(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      return { round_id: generateRoundId('compacted'), message_index: 0, block_index: 0 };
    },
    stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      const round_id = state.currentRoundId ?? generateRoundId('diagnostic');
      return { round_id, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
    },
    closeRound(sessionId: string): void {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      state.nextBlockIndex = 0;
    },
    recordAppend(): void {},
    getActivityStatus(): { status: 'idle'; pending_calls: []; updated_at: string } { return { status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() }; },
  };
  return runtime as unknown as TestAnalystRuntime;
}

export function createTestRuntimeApplication(opts: { eventBus?: EventBus } = {}): RuntimeApplication {
  const activeRuntime = createTestActiveRuntime(opts);
  return {
    runtimeApi: {
      start: () => activeRuntime.start(),
      shutdown: () => activeRuntime.shutdown(),
      pause: () => activeRuntime.pause(),
      resume: () => activeRuntime.resume(),
      startProject: (source) => activeRuntime.startProject(source),
      stopProject: (source) => activeRuntime.stopProject(source),
      subscribe: (options) => activeRuntime.subscribe(options),
      getStatus: () => activeRuntime.getStatus(),
      getActivityStatus: (sessionId) => activeRuntime.getActivityStatus(sessionId),
    },
    get analystDeps() {
      return {
        runtime: activeRuntime,
        stamper: activeRuntime,
        candidateAvailability: activeRuntime.candidateAvailability,
        eventLogger: activeRuntime.eventLogger,
        emitAnalystToolInvoked: (payload: Parameters<typeof activeRuntime.emitAnalystToolInvoked>[0]) => activeRuntime.emitAnalystToolInvoked(payload),
        mcpManager: activeRuntime.mcpManager,
      };
    },
    setMcpManager: (mcpManager) => activeRuntime.setMcpManager(mcpManager),
  };
}
