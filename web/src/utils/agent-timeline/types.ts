import type { ActivityStatus, AgentConversationEntry } from '../../api/types';

export type TimelineRoundKind = 'pre' | 'user' | 'assistant' | 'diagnostic' | 'compacted';
export interface ParsedRoundId { kind: TimelineRoundKind; tier: number; }
export interface ToolPair { call: AgentConversationEntry; result: AgentConversationEntry | null; status: 'pending' | 'ok' | 'error'; }
export interface TimelineRound { id: string; kind: TimelineRoundKind; position: number; entries: AgentConversationEntry[]; texts: AgentConversationEntry[]; diagnostics: AgentConversationEntry[]; toolPairs: ToolPair[]; activityStatus: ActivityStatus | null; }
export interface AgentTimeline { rounds: TimelineRound[]; activeRoundId: string | null; }
