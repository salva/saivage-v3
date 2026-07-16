import type { ActivityStatus, AgentConversationEntry } from '../../api/types';
import { parseToolCallMessage } from '../persistedToolCall';
import { parseRoundId } from './round-id';
import type { AgentTimeline, TimelineRound, ToolPair } from './types';
import { groupToolPairs } from '../tool-friendly';
import { presentToolResult } from '../tool-presenters';

type TimelineEntry = AgentConversationEntry;

type IndexedTimelineEntry = {
  entry: TimelineEntry;
  originalIndex: number;
};

function compareEntry(a: TimelineEntry, b: TimelineEntry): number {
  return a.message_index - b.message_index || a.block_index - b.block_index || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

function callIdOf(entry: AgentConversationEntry): string | undefined {
  if (entry.tool_call_id) return entry.tool_call_id;
  try { return parseToolCallMessage(JSON.parse(entry.content)).id; } catch { return undefined; }
}

function buildToolPairs(entries: TimelineEntry[]): ToolPair[] {
  const calls = entries.filter((entry) => entry.kind === 'tool_call');
  const results = entries.filter((entry) => entry.kind === 'tool_result');
  return calls.map((call): ToolPair => {
    const id = callIdOf(call);
    const result = id ? results.find((entry) => callIdOf(entry) === id) ?? null : null;
    return { call, result, status: result ? presentToolResult(result.content, { tool: result.tool }).status : 'pending' };
  });
}

function isDisplayTextEntry(entry: TimelineEntry): boolean {
  if (entry.kind === 'text') return entry.content.trim().length > 0;
  if (entry.kind === 'system_prompt') return entry.content.trim().length > 0;
  return false;
}

function hasVisibleRoundContent(round: TimelineRound): boolean {
  return round.texts.length > 0
    || round.diagnostics.length > 0
    || round.items.length > 0
    || (round.activityStatus !== null && round.activityStatus.status !== 'idle');
}

function roundOrderKey(entries: IndexedTimelineEntry[]): [number, string, string] {
  let minIndex = Number.POSITIVE_INFINITY;
  let minTs = '';
  let minId = '';
  for (const { entry, originalIndex } of entries) {
    if (originalIndex < minIndex) {
      minIndex = originalIndex;
      minTs = entry.timestamp;
      minId = entry.id;
    } else if (originalIndex === minIndex) {
      if (!minTs || entry.timestamp.localeCompare(minTs) < 0 || (entry.timestamp === minTs && entry.id.localeCompare(minId) < 0)) {
        minTs = entry.timestamp;
        minId = entry.id;
      }
    }
  }
  return [Number.isFinite(minIndex) ? minIndex : 0, minTs, minId];
}

function projectToolResultsIntoCallRounds(entries: IndexedTimelineEntry[]): IndexedTimelineEntry[] {
  const callRoundById = new Map<string, string>();
  for (const { entry } of entries) {
    if (entry.kind !== 'tool_call') continue;
    const id = callIdOf(entry);
    if (id) callRoundById.set(id, entry.round_id);
  }

  return entries.map((indexed) => {
    const { entry } = indexed;
    if (entry.kind !== 'tool_result') return indexed;
    const id = callIdOf(entry);
    const round_id = id ? callRoundById.get(id) : undefined;
    return round_id && round_id !== entry.round_id ? { ...indexed, entry: { ...entry, round_id } } : indexed;
  });
}

export function entriesToTimeline(entries: readonly AgentConversationEntry[], activityStatus: ActivityStatus | null): AgentTimeline {
  const grouped = new Map<string, IndexedTimelineEntry[]>();
  const indexedEntries = entries.map((entry, originalIndex) => ({ entry, originalIndex }));
  const projectedEntries = projectToolResultsIntoCallRounds(indexedEntries);
  for (const normalized of projectedEntries) {
    const bucket = grouped.get(normalized.entry.round_id) ?? [];
    bucket.push(normalized);
    grouped.set(normalized.entry.round_id, bucket);
  }
  const sortedGroups = [...grouped.entries()]
    .map(([id, roundEntries]) => ({ id, entries: roundEntries, key: roundOrderKey(roundEntries) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1].localeCompare(b.key[1]) || a.key[2].localeCompare(b.key[2]));
  const builtRounds: TimelineRound[] = sortedGroups.map(({ id, entries: roundEntries }, idx) => {
    const parsed = parseRoundId(id);
    const sorted = [...roundEntries].map(({ entry }) => entry).sort(compareEntry);
    const toolPairs = buildToolPairs(sorted);
    return { id, kind: parsed.kind, position: idx + 1, entries: sorted, texts: sorted.filter(isDisplayTextEntry), diagnostics: sorted.filter((entry) => entry.kind === 'model_issue' || entry.kind === 'model_repair' || entry.kind === 'context_compaction' || entry.kind === 'model_recovered'), toolPairs, items: groupToolPairs(id, toolPairs), activityStatus: null };
  });
  const activeRound = [...builtRounds].reverse().find((round: TimelineRound) => round.kind === 'assistant') ?? builtRounds[builtRounds.length - 1] ?? null;
  if (activeRound && activityStatus && activityStatus.status !== 'idle') activeRound.activityStatus = activityStatus;
  const rounds = builtRounds.filter(hasVisibleRoundContent).map((round, idx) => ({ ...round, position: idx + 1 }));
  const visibleActiveRound = activeRound ? rounds.find((round) => round.id === activeRound.id) ?? null : null;
  return { rounds, activeRoundId: visibleActiveRound?.id ?? null, modelLabel: null };
}
