import type { ActivityStatus, ConversationEntry } from '../../api/types';

export type TimelineRoundKind = 'pre' | 'user' | 'assistant' | 'diagnostic' | 'compacted';
export interface ParsedRoundId { kind: TimelineRoundKind; tier: number; }
export interface ToolPair { call: ConversationEntry; result: ConversationEntry | null; status: 'pending' | 'ok' | 'error'; }
export interface TimelineRound { id: string; kind: TimelineRoundKind; position: number; entries: ConversationEntry[]; texts: ConversationEntry[]; diagnostics: ConversationEntry[]; toolPairs: ToolPair[]; activityStatus: ActivityStatus | null; }
export interface AgentTimeline { rounds: TimelineRound[]; activeRoundId: string | null; }
