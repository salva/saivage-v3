import type { ActivityStatus, ConversationEntry } from '../../api/types';
import { parseToolCallMessage } from '../persistedToolCall';
import { isRoundId, parseRoundId } from './round-id';
import type { AgentTimeline, TimelineRound, TimelineRoundKind, ToolPair } from './types';

type TimelineEntry = ConversationEntry & { round_id: string; message_index: number; block_index: number };

function compareEntry(a: TimelineEntry, b: TimelineEntry): number {
  return a.message_index - b.message_index || a.block_index - b.block_index || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function callIdOf(entry: ConversationEntry): string | undefined {
  if (entry.tool_call_id) return entry.tool_call_id;
  try { return parseToolCallMessage(JSON.parse(entry.content)).id; } catch { return undefined; }
}

function buildToolPairs(entries: TimelineEntry[]): ToolPair[] {
  const calls = entries.filter((entry) => entry.kind === 'tool_call');
  const results = entries.filter((entry) => entry.kind === 'tool_result' || entry.kind === 'tool_error');
  return calls.map((call) => {
    const id = callIdOf(call);
    const result = id ? results.find((entry) => callIdOf(entry) === id) ?? null : null;
    return { call, result, status: result?.kind === 'tool_error' ? 'error' : result ? 'ok' : 'pending' };
  });
}

function fallbackRoundKind(entry: ConversationEntry): TimelineRoundKind {
  if (entry.role === 'user') return 'user';
  if (entry.kind === 'model_issue' || entry.kind === 'model_repair' || entry.kind === 'context_compaction' || entry.kind === 'model_recovered') return 'diagnostic';
  return 'assistant';
}

function fallbackRoundId(entry: ConversationEntry, index: number): string {
  const suffix = (index + 1).toString(16).padStart(32, '0');
  return `r-${fallbackRoundKind(entry)}-${suffix}`;
}

function normalizeEntry(entry: ConversationEntry, index: number): TimelineEntry {
  const round_id = isRoundId(entry.round_id) ? entry.round_id : fallbackRoundId(entry, index);
  const message_index = Number.isFinite(entry.message_index) ? entry.message_index : index;
  const block_index = Number.isFinite(entry.block_index) ? entry.block_index : 0;
  return { ...entry, round_id, message_index, block_index };
}

function roundOrderKey(entries: TimelineEntry[]): [number, string, string] {
  let minMsg = Number.POSITIVE_INFINITY;
  let minTs = '';
  let minId = '';
  for (const entry of entries) {
    if (entry.message_index < minMsg) {
      minMsg = entry.message_index;
      minTs = entry.timestamp;
      minId = entry.id;
    } else if (entry.message_index === minMsg) {
      if (!minTs || entry.timestamp.localeCompare(minTs) < 0) { minTs = entry.timestamp; minId = entry.id; }
    }
  }
  return [Number.isFinite(minMsg) ? minMsg : 0, minTs, minId];
}

export function entriesToTimeline(entries: readonly ConversationEntry[], activityStatus: ActivityStatus | null): AgentTimeline {
  const grouped = new Map<string, TimelineEntry[]>();
  for (const [index, entry] of entries.entries()) {
    const normalized = normalizeEntry(entry, index);
    const bucket = grouped.get(normalized.round_id) ?? [];
    bucket.push(normalized);
    grouped.set(normalized.round_id, bucket);
  }
  const sortedGroups = [...grouped.entries()]
    .map(([id, roundEntries]) => ({ id, entries: roundEntries, key: roundOrderKey(roundEntries) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1].localeCompare(b.key[1]) || a.key[2].localeCompare(b.key[2]));
  const rounds: TimelineRound[] = sortedGroups.map(({ id, entries: roundEntries }, idx) => {
    const parsed = parseRoundId(id);
    const sorted = [...roundEntries].sort(compareEntry);
    return { id, kind: parsed.kind, position: idx + 1, entries: sorted, texts: sorted.filter((entry) => entry.kind === 'text' || entry.kind === 'activity'), diagnostics: sorted.filter((entry) => entry.kind === 'model_issue' || entry.kind === 'model_repair' || entry.kind === 'context_compaction' || entry.kind === 'model_recovered'), toolPairs: buildToolPairs(sorted), activityStatus: null };
  });
  const activeRound = [...rounds].reverse().find((round: TimelineRound) => round.kind === 'assistant') ?? rounds[rounds.length - 1] ?? null;
  if (activeRound && activityStatus && activityStatus.status !== 'idle') activeRound.activityStatus = activityStatus;
  return { rounds, activeRoundId: activeRound?.id ?? null };
}
