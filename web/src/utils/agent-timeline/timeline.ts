import type { ActivityStatus, ConversationEntry } from '../../api/types';
import { parseRoundId, roundIdSortKey } from './round-id';
import type { AgentTimeline, TimelineRound, ToolPair } from './types';

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

export function entriesToTimeline(entries: readonly ConversationEntry[], activityStatus: ActivityStatus | null): AgentTimeline {
  const grouped = new Map<string, ConversationEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.round_id) ?? [];
    bucket.push(entry);
    grouped.set(entry.round_id, bucket);
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
