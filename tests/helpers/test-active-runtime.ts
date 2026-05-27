import { EventBus } from '../../src/events/bus.js';
import type { ActiveRuntime } from '../../src/runtime/control-api.js';
import type { RoundStamp } from '../../src/agents/session-persistence.js';

interface TestRoundState { nextRound: number; currentRoundId: string | null; nextMessageIndex: number; nextBlockIndex: number; compactedCount: number; }

export function createTestActiveRuntime(opts: { eventBus?: EventBus } = {}): ActiveRuntime {
  const eventBus = opts.eventBus ?? new EventBus();
  const states = new Map<string, TestRoundState>();
  const stateFor = (sessionId: string): TestRoundState => {
    let state = states.get(sessionId);
    if (!state) {
      state = { nextRound: 1, currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0, compactedCount: 0 };
      states.set(sessionId, state);
    }
    return state;
  };
  const runtime = {
    runtime: { eventBus, eventLogger: undefined },
    openAssistantRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = `r-assistant-${state.nextRound++}`;
      state.nextMessageIndex = 0;
      state.nextBlockIndex = 0;
      return this.stampInRound(sessionId);
    },
    stampInRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      if (!state.currentRoundId) state.currentRoundId = `r-assistant-${state.nextRound++}`;
      return { round_id: state.currentRoundId, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
    },
    stampUserMessage(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.currentRoundId = null;
      state.nextBlockIndex = 0;
      return { round_id: `r-user-${state.nextRound++}`, message_index: 0, block_index: 0 };
    },
    stampPre(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      return { round_id: `r-pre-${state.nextRound++}`, message_index: 0, block_index: 0 };
    },
    stampCompacted(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      state.compactedCount += 1;
      state.currentRoundId = null;
      return { round_id: `r-compacted-${state.compactedCount}`, message_index: 0, block_index: 0 };
    },
    stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
      const state = stateFor(sessionId);
      const round_id = state.currentRoundId ?? `r-diagnostic-${state.nextRound++}`;
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
  return runtime as unknown as ActiveRuntime;
}
