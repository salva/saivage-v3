import { hashConversationRows } from '../../src/contracts/conversation-compaction.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';

const TIMESTAMP = '2026-07-17T00:00:00.000Z';

export function compactedConversationFixture(sessionId: ConversationSessionId, includePrivatePair = false): {
  rows: AgentMessage[];
  c1CoveredIds: string[];
  c1Summary: string;
  c2Summary: string;
  privatePairIds: string[];
} {
  const first = round(sessionId, 'one', 1);
  const second = round(sessionId, 'two', 2);
  const c1Summary = 'C1 obsolete summary';
  const c2Summary = 'C2 current summary';
  const c1 = compaction(sessionId, 'c1', [first], c1Summary, 3);
  const c2 = compaction(sessionId, 'c2', [first, second], c2Summary, 4);
  const suffix = text(sessionId, 'suffix', 'uncovered suffix', 5, 'user');
  const pair = includePrivatePair ? privatePair(sessionId) : [];
  return { rows: [...first, c1, ...second, c2, suffix, ...pair], c1CoveredIds: first.map((row) => row.id), c1Summary, c2Summary, privatePairIds: pair.map((row) => row.id) };
}

function round(sessionId: ConversationSessionId, name: string, index: number): AgentMessage[] {
  const roundId = `r-user-${String(index).padStart(32, '0')}`;
  const role = sessionId.slice(0, sessionId.indexOf(':'));
  const marker = role === 'analyst'
    ? { event: 'activation_open', role, input_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, timestamp: TIMESTAMP }
    : { event: 'activation_open', role, card_id: sessionId.slice(sessionId.indexOf(':') + 1), input_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, timestamp: TIMESTAMP };
  return [
    agentMessageSchema.parse({ id: `${name}-activation`, session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify(marker), round_id: roundId, message_index: 0, block_index: 0, timestamp: TIMESTAMP }),
    agentMessageSchema.parse({ id: `${name}-text`, session_id: sessionId, role: 'user', kind: 'text', content: `${name} covered history`, round_id: roundId, message_index: 1, block_index: 0, timestamp: TIMESTAMP }),
  ];
}

function compaction(sessionId: ConversationSessionId, id: string, rounds: AgentMessage[][], summaryText: string, index: number): AgentMessage {
  const payload = contextCompactionContentSchema.parse({
    boundary: 'round',
    retained_static_message_ids: [],
    summaries: rounds.map((rows) => ({
      kind: 'individual',
      rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: rows.map((row) => row.id) }] }],
      content_hash: hashConversationRows(rows),
      summary_text: summaryText,
      evidence: [],
    })),
    applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' },
  });
  return agentMessageSchema.parse({ id, session_id: sessionId, role: 'system', kind: 'context_compaction', content: canonicalJson(payload), round_id: `r-compacted-${String(index).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp: TIMESTAMP });
}

function privatePair(sessionId: ConversationSessionId): AgentMessage[] {
  const sourceInputId = '11111111-1111-4111-8111-111111111111';
  const privateId = 'private-uncovered';
  const visibleId = 'visible-uncovered';
  const privateRow = agentMessageSchema.parse({ id: privateId, session_id: sessionId, role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: sourceInputId, projection_message_id: visibleId, provider: 'openai', model: 'gpt-5.6', output: [{ type: 'message', content: [{ type: 'output_text', text: 'private uncovered output' }] }] }), round_id: 'r-assistant-00000000000000000000000000000006', message_index: 0, block_index: 0, timestamp: TIMESTAMP });
  const visible = agentMessageSchema.parse({ ...text(sessionId, visibleId, 'visible uncovered output', 6, 'assistant'), provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: privateId, projection_kind: 'assistant_message' } });
  return [privateRow, visible];
}

function text(sessionId: string, id: string, content: string, index: number, role: 'user' | 'assistant'): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: sessionId, role, kind: 'text', content, round_id: `r-${role}-${String(index).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp: TIMESTAMP });
}
