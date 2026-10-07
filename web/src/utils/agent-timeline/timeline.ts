import type { AgentConversationEntry } from '../../api/types';
import { parseToolCallMessage } from '../persistedToolCall';
import { parseRoundId } from './round-id';
import type { AgentTimeline, TimelineRound } from './types';
import { activationEntry } from './activation';

function callIdOf(entry: AgentConversationEntry): string | undefined {
  if (entry.tool_call_id) return entry.tool_call_id;
  return entry.kind === 'tool_call' ? parseToolCallMessage(JSON.parse(entry.content)).id : undefined;
}
function visible(entry: AgentConversationEntry): boolean {
  return entry.kind === 'tool_call' || entry.kind === 'tool_result' || entry.kind === 'content_policy_refusal'
    || (entry.kind === 'text' && entry.content.trim().length > 0)
    || ['model_issue', 'model_repair', 'model_recovered'].includes(entry.kind)
    || activationEntry(entry) !== null;
}
export function entriesToTimeline(entries: readonly AgentConversationEntry[]): AgentTimeline {
  // Exact selected-segment association supplies context only, never position or ownership.
  const calls = new Map<string, AgentConversationEntry>();
  const results = new Map<string, AgentConversationEntry>();
  for (const entry of entries) {
    if (entry.kind !== 'tool_call' && entry.kind !== 'tool_result') continue;
    const id = callIdOf(entry);
    if (id) (entry.kind === 'tool_call' ? calls : results).set(id, entry);
  }
  const rounds: TimelineRound[] = [];
  let previousRoundId: string | null = null;
  for (const entry of entries) {
    const kind = parseRoundId(entry.round_id).kind;
    const newRun = previousRoundId !== entry.round_id;
    previousRoundId = entry.round_id;
    if (kind !== 'compacted' && !visible(entry)) continue;
    let round = rounds.at(-1);
    if (!round || newRun || round.entries[0].round_id !== entry.round_id) {
      round = { id: `${entry.round_id}:${entry.id}`, kind, position: rounds.length + 1, entries: [], rows: [] };
      rounds.push(round);
    }
    round.entries.push(entry);
    const id = callIdOf(entry);
    round.rows.push({ entry, mate: id ? (entry.kind === 'tool_call' ? results : calls).get(id) ?? null : null });
  }
  return { rounds };
}
