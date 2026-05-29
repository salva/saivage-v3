import type { ActivityStatus, ConversationEntry } from '../../api/types';
import { isRoundId, parseRoundId, roundIdSortKey } from './round-id';
import type { AgentTimeline, TimelineRound, TimelineRoundKind, ToolPair } from './types';

function compareEntry(a: ConversationEntry, b: ConversationEntry): number {
  return a.message_index - b.message_index || a.block_index - b.block_index || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function buildToolPairs(entries: ConversationEntry[]): ToolPair[] {
  const calls = entries.filter((entry) => entry.kind === 'tool_call');
  const results = entries.filter((entry) => entry.kind === 'tool_result' || entry.kind === 'tool_error');
  return calls.map((call) => {
    const result = results.find((entry) => entry.tool_call_id && entry.tool_call_id === call.tool_call_id) ?? null;
    return { call, result, status: result?.kind === 'tool_error' ? 'error' : result ? 'ok' : 'pending' };
  });
}

function fallbackRoundKind(entry: ConversationEntry): TimelineRoundKind {
  if (entry.role === 'user') return 'user';
  if (entry.kind === 'model_issue' || entry.kind === 'model_repair' || entry.kind === 'model_recovered') return 'diagnostic';
  return 'assistant';
}

function normalizeEntry(entry: ConversationEntry, index: number): ConversationEntry {
  const round_id = isRoundId(entry.round_id) ? entry.round_id : `r-${fallbackRoundKind(entry)}-${index + 1}`;
  const message_index = Number.isFinite(entry.message_index) ? entry.message_index : index;
  const block_index = Number.isFinite(entry.block_index) ? entry.block_index : 0;
  return { ...entry, round_id, message_index, block_index };
}

export function entriesToTimeline(entries: readonly ConversationEntry[], activityStatus: ActivityStatus | null): AgentTimeline {
  const grouped = new Map<string, ConversationEntry[]>();
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeEntry(entry, index);
    const bucket = grouped.get(normalized.round_id) ?? [];
    bucket.push(normalized);
    grouped.set(normalized.round_id, bucket);
  }
  const rounds: TimelineRound[] = [...grouped.entries()]
    .sort(([a], [b]) => { const ak = roundIdSortKey(a); const bk = roundIdSortKey(b); return ak[0] - bk[0] || ak[1] - bk[1] || ak[2].localeCompare(bk[2]); })
    .map(([id, roundEntries]) => {
      const parsed = parseRoundId(id);
      const sorted = [...roundEntries].sort(compareEntry);
      return { id, kind: parsed.kind, ordinal: parsed.ordinal, entries: sorted, texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity'), diagnostics: sorted.filter((entry) => entry.kind === 'model_issue' || entry.kind === 'model_repair' || entry.kind === 'model_recovered'), toolPairs: buildToolPairs(sorted), activityStatus: null };
    });
  const activeRound = [...rounds].reverse().find((round: TimelineRound) => round.kind === 'assistant') ?? rounds[rounds.length - 1] ?? null;
  if (activeRound && activityStatus && activityStatus.status !== 'idle') activeRound.activityStatus = activityStatus;
  return { rounds, activeRoundId: activeRound?.id ?? null };
}
