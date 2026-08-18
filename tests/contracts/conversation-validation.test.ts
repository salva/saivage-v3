import { describe, expect, it } from '@jest/globals';

import { hashConversationRows, renderContextCompactionPayload, validateConversation, validateProspectiveContextCompaction, type ContextCompactionMetadata } from '../../src/contracts/conversation-validation.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage } from '../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';

const SESSION = 'agent:planner:project' as const;
describe('canonical conversation validation', () => {
  it('materializes physical and inherited activation checkpoints without fabricating a marker', () => {
    const physical = validateConversation(SESSION, [activation(), text('tail')]);
    expect(physical.rounds[0]!.activation).toMatchObject({ source: 'row', message: { id: 'activation' } });
    const inherited = validateConversation(SESSION, [text('tail')], { markerId: 'activation', inputId: INPUT, activeSegmentKind: 'repair', startOrdinal: 0 });
    expect(inherited.rounds[0]).toMatchObject({ label: 'activation', activation: { source: 'compacted_genesis', marker_id: 'activation', input_id: INPUT }, segments: [{ kind: 'repair' }] });
    expect(inherited.physicalRows.map((row) => row.id)).toEqual(['tail']);
  });

  it('validates a prospective compaction without admitting a durable metadata message kind', () => {
    const rows = [activation(), text('tail')]; const conversation = validateConversation(SESSION, rows); const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: rows.map((row) => row.id) }] }], content_hash: hashConversationRows(rows), summary_text: 'summary', evidence: [] }], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 0, trigger_fraction: 0.8, completion_reserve_fraction: 0.1, merge_line_fraction: 0.2, summary_line_fraction: 0.5, snap: 'keep_straddler_verbatim' } });
    const metadata: ContextCompactionMetadata = { id: 'candidate', session_id: SESSION, role: 'system', kind: 'context_compaction', content: canonicalJson(payload), round_id: `r-compacted-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' };
    const prospective = validateProspectiveContextCompaction(conversation, metadata);
    expect(prospective.latestCompaction?.payload).toEqual(payload);
    expect(prospective.physicalRows).toEqual(rows);
    expect(renderContextCompactionPayload(payload)).toContain('summary');
    expect(agentMessageSchema.safeParse(metadata).success).toBe(false);
  });

  it('rejects duplicate source identities and non-final unmatched tool calls', () => {
    expect(() => validateConversation(SESSION, [text('same'), text('same')])).toThrow(/duplicate message ids/);
  });
});

const INPUT = '00000000-0000-4000-8000-000000000001';
function activation(): AgentMessage { const timestamp = '2026-08-11T00:00:00.000Z'; return agentMessageSchema.parse({ id: 'activation', context_policy: ACTIVITY_ROW_POLICY, session_id: SESSION, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: INPUT, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, context_policy: TEXT_ROW_POLICY, session_id: SESSION, role: 'assistant', kind: 'text', content: id, round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }
