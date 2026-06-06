import type { AgentMessage } from '../schemas/index.js';

export interface RoundStamp { round_id: string; message_index: number; block_index: number; }
export interface PendingCall { id: string; tool: string; started_at: string; }
export type ActivityStatus = 'idle' | 'thinking' | 'tool_calling' | 'responding' | 'compacting';
export interface SessionActivity { status: ActivityStatus; pending_calls: PendingCall[]; updated_at: string; }
export interface SessionRoundState { currentRoundId: string | null; nextMessageIndex: number; nextBlockIndex: number; activity: SessionActivity; }

export interface RuntimeAppendRecorder { recordAppend(message: AgentMessage): void; }

export interface SessionStamper extends RuntimeAppendRecorder {
  openAssistantRound(sessionId: string): RoundStamp;
  stampInRound(sessionId: string): RoundStamp;
  stampUserMessage(sessionId: string): RoundStamp;
  stampPre(sessionId: string): RoundStamp;
  stampCompacted(sessionId: string): RoundStamp;
  stampDiagnosticInCurrentRound(sessionId: string): RoundStamp;
  closeRound(sessionId: string): void;
}
