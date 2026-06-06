import type { AgentMessage } from '../schemas/index.js';
import { generateRoundId } from '../schemas/round-id-server.js';
import type { RoundStamp, SessionActivity, SessionRoundState, SessionStamper } from './session-stamper.js';

function emptyActivity(): SessionActivity {
  return { status: 'idle', pending_calls: [], updated_at: new Date().toISOString() };
}

export class SessionStampCounter implements SessionStamper {
  private readonly roundStates = new Map<string, SessionRoundState>();

  private getRoundState(sessionId: string): SessionRoundState {
    let state = this.roundStates.get(sessionId);
    if (!state) {
      state = { currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0, activity: emptyActivity() };
      this.roundStates.set(sessionId, state);
    }
    return state;
  }

  openAssistantRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = generateRoundId('assistant');
    state.nextMessageIndex = 0;
    state.nextBlockIndex = 0;
    state.activity = { ...state.activity, status: 'thinking', updated_at: new Date().toISOString() };
    return this.stampInRound(sessionId);
  }

  stampInRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    if (!state.currentRoundId) state.currentRoundId = generateRoundId('assistant');
    return { round_id: state.currentRoundId, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
  }

  stampUserMessage(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = null;
    state.nextBlockIndex = 0;
    return { round_id: generateRoundId('user'), message_index: 0, block_index: 0 };
  }

  stampPre(_sessionId: string): RoundStamp {
    return { round_id: generateRoundId('pre'), message_index: 0, block_index: 0 };
  }

  stampCompacted(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = null;
    return { round_id: generateRoundId('compacted'), message_index: 0, block_index: 0 };
  }

  stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    const round_id = state.currentRoundId ?? generateRoundId('diagnostic');
    return { round_id, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
  }

  closeRound(sessionId: string): void {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = null;
    state.nextBlockIndex = 0;
    state.activity = { ...state.activity, status: 'idle', updated_at: new Date().toISOString() };
  }

  recordAppend(message: AgentMessage): void {
    const state = this.getRoundState(message.session_id);
    if (message.kind === 'tool_call' && message.tool_call_id) {
      state.activity = { status: 'tool_calling', pending_calls: [...state.activity.pending_calls, { id: message.tool_call_id, tool: message.tool ?? 'tool', started_at: message.timestamp }], updated_at: new Date().toISOString() };
    } else if ((message.kind === 'tool_result' || message.kind === 'tool_error') && message.tool_call_id) {
      state.activity = { status: 'responding', pending_calls: state.activity.pending_calls.filter((call) => call.id !== message.tool_call_id), updated_at: new Date().toISOString() };
    } else if (message.kind === 'text' && message.role === 'assistant') {
      state.activity = { ...state.activity, status: 'responding', updated_at: new Date().toISOString() };
    }
  }

  getActivityStatus(sessionId: string): SessionActivity {
    return this.getRoundState(sessionId).activity;
  }
}
