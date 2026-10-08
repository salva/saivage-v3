import type { AgentConversationEntry } from '../../api/types';
export type TimelineRoundKind = 'pre' | 'user' | 'assistant' | 'compacted';
export interface ParsedRoundId { kind: TimelineRoundKind }
export interface TimelineRow {
  entry: AgentConversationEntry;
  mate: AgentConversationEntry | null;
  interveningEntries?: number;
}
export interface TimelineRound {
  id: string;
  kind: TimelineRoundKind;
  position: number;
  entries: AgentConversationEntry[];
  rows: TimelineRow[];
}
export interface AgentTimeline { rounds: TimelineRound[] }
