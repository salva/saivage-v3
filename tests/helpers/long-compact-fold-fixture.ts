import { hashConversationRows } from '../../src/contracts/conversation-compaction.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';

const SESSION: ConversationSessionId = 'agent:planner:card-a';
const TIMESTAMP = '2026-07-24T00:00:00.000Z';

export function longCompactFoldFixture(contentBytes: number): { sessionId: ConversationSessionId; bytes: Buffer; rows: AgentMessage[]; sourceRows: AgentMessage[] } {
  const staticRow = message('static', 'system', 'system_prompt', 'static instructions');
  const rounds = Array.from({ length: 6 }, (_unused, index) => round(index + 1, contentBytes));
  const sourceRows = [staticRow, ...rounds.flat()];
  const c1 = compaction('compaction-1', rounds.slice(0, 3), false);
  const c2 = compaction('compaction-2', rounds.slice(0, 5), false);
  const c3 = compaction('compaction-3', rounds, true);
  const envelopes = [
    serializeGrowingEnvelope([staticRow], agentMessageSchema),
    ...rounds.slice(0, 3).map((rows) => serializeGrowingEnvelope(rows, agentMessageSchema)),
    serializeGrowingEnvelope([c1], agentMessageSchema),
    ...rounds.slice(3, 5).map((rows) => serializeGrowingEnvelope(rows, agentMessageSchema)),
    serializeGrowingEnvelope([c2], agentMessageSchema),
    serializeGrowingEnvelope(rounds[5]!, agentMessageSchema),
    serializeGrowingEnvelope([c3], agentMessageSchema),
  ];
  return { sessionId: SESSION, bytes: Buffer.concat(envelopes), rows: [staticRow, ...rounds.slice(0, 3).flat(), c1, ...rounds.slice(3, 5).flat(), c2, ...rounds[5]!, c3], sourceRows };
}

function round(index: number, contentBytes: number): AgentMessage[] {
  const identity = conversationSessionIdentity(SESSION);
  const marker = message(`round-${index}-activation`, 'system', 'activity', JSON.stringify({
    event: 'activation_open', agent_name: identity.agentName, card_id: identity.cardId,
    input_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, timestamp: TIMESTAMP,
  }));
  return [
    marker,
    message(`round-${index}-text`, 'user', 'text', `source-${index}-${'x'.repeat(contentBytes)}`),
    message(`round-${index}-repair`, 'system', 'model_repair', `repair-${index}`),
    message(`round-${index}-after-repair`, 'assistant', 'text', `repaired-${index}-${'y'.repeat(contentBytes)}`),
  ];
}

function compaction(id: string, coveredRounds: AgentMessage[][], partialFinal: boolean): AgentMessage {
  const descriptors = coveredRounds.map((rows, index) => {
    const selected = partialFinal && index === coveredRounds.length - 1 ? rows.slice(0, 1) : rows;
    const segments = selected.length <= 2
      ? [{ kind: 'initial' as const, source_message_ids: selected.map((row) => row.id) }]
      : [
          { kind: 'initial' as const, source_message_ids: selected.slice(0, 2).map((row) => row.id) },
          { kind: 'repair' as const, source_message_ids: selected.slice(2).map((row) => row.id) },
        ];
    return { selected, round: { complete: selected.length === rows.length, segments } };
  });
  const merged = descriptors.slice(0, 2);
  const groups = [
    { kind: 'merged' as const, rounds: merged.map(({ round }) => round), content_hash: hashConversationRows(merged.flatMap(({ selected }) => selected)), summary_text: 'merged summary', evidence: [] },
    ...descriptors.slice(2).map(({ selected, round }, index) => ({ kind: 'individual' as const, rounds: [round], content_hash: hashConversationRows(selected), summary_text: `summary ${index + 2}`, evidence: [] })),
  ];
  const payload = contextCompactionContentSchema.parse({
    boundary: partialFinal ? 'message' : 'round', retained_static_message_ids: ['static'], summaries: groups,
    applied_policy: { mode: partialFinal ? 'hard_limit_fallback' : 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 1, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' },
  });
  return message(id, 'system', 'context_compaction', canonicalJson(payload));
}

function message(id: string, role: AgentMessage['role'], kind: AgentMessage['kind'], content: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: SESSION, role, kind, content, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: TIMESTAMP });
}
