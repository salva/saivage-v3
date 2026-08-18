import { describe, expect, it } from '@jest/globals';

import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { accumulatedSummarySha256, agentMessageSchema, compactedHistorySchema, coveredSourceGroupsSha256, type AgentMessage, type CompactedHistory } from '../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const SESSION = 'agent:planner:project' as const;
describe('canonical conversation validation', () => {
  it('materializes physical and inherited activation checkpoints without fabricating a marker', () => {
    const physical = validateConversation(SESSION, [activation(), text('tail')]);
    expect(physical.rounds[0]!.activation).toMatchObject({ source: 'row', message: { id: 'activation' } });
    const inherited = validateConversation(SESSION, [text('tail')], { markerId: 'activation', inputId: INPUT, activeSegmentKind: 'repair', startOrdinal: 0 });
    expect(inherited.rounds[0]).toMatchObject({ label: 'activation', state: 'open', activation: { source: 'compacted_genesis', marker_id: 'activation', input_id: INPUT }, segments: [{ kind: 'repair' }] });
    expect(inherited.physicalRows.map((row) => row.id)).toEqual(['tail']);
  });

  it('derives explicit round state where only the newest activation is open', () => {
    const conversation = validateConversation(SESSION, [activation('activation-a', INPUT), text('a1'), activation('activation-b', OTHER_INPUT), text('b1')]);
    expect(conversation.rounds.map((round) => round.state)).toEqual(['closed', 'open']);
    expect(validateConversation(SESSION, []).rounds).toEqual([]);
  });

  it('rejects duplicate source identities and non-final unmatched tool calls', () => {
    expect(() => validateConversation(SESSION, [text('same'), text('same')])).toThrow(/duplicate message ids/);
  });

  it('validates self-contained compacted genesis commitments on read', () => {
    const history = validHistory() as CompactedHistory;
    const conversation = validateConversation(SESSION, [], { markerId: 'activation', inputId: INPUT, activeSegmentKind: 'initial', startOrdinal: 0 }, { id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history, sourceVersion: 3 });
    expect(conversation.effectiveCompactedHistory).toEqual(history);
    expect(conversation.effectiveValidatedCoverage).toEqual(history.coverageCommitment);
    expect(conversation.effectiveRequiredModelFacts).toEqual(history.requiredModelFacts);
    expect(conversation.compactedGenesis).toEqual({ id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z' });
  });

  it('rejects compacted genesis commitments that do not tie to their own source identity', () => {
    const history = validHistory();
    expect(() => validateConversation(SESSION, [], undefined, { id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history: { ...history, coverageCommitment: { ...history.coverageCommitment, sourceVersion: 4 } }, sourceVersion: 3 })).toThrow(/does not name its own source segment version/);
    expect(() => validateConversation(SESSION, [], undefined, { id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history: { ...history, coverageCommitment: { ...history.coverageCommitment, accumulatedSummarySha256: '0'.repeat(64) } }, sourceVersion: 3 })).toThrow(/summary hash/);
  });

  it('rejects malformed required-model-fact slots', () => {
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: { sourceMessageId: `${INPUT}:other`, activationInputId: INPUT }, latestContentPolicyRefusal: null } }))).toThrow(/activation-derived recovery identity/);
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: null, latestContentPolicyRefusal: { markerId: 'not-a-uuid', activationInputId: INPUT } } }))).toThrow();
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: null, latestContentPolicyRefusal: null }, dispositionsOverride: { sha256: 'a'.repeat(64), count: 5, summarized: 2, evidenceOnly: 2, superseded: 2 } }))).toThrow(/sum of its kinds/);
  });
});

const INPUT = '00000000-0000-4000-8000-000000000001';
const OTHER_INPUT = '00000000-0000-4000-8000-000000000002';
const GENESIS_ID = '11111111-1111-4111-8111-111111111111';
const MARKER_ID = '22222222-2222-4222-8222-222222222222';

function activation(id = 'activation', inputId = INPUT): AgentMessage { const timestamp = '2026-08-11T00:00:00.000Z'; return agentMessageSchema.parse({ id, context_policy: ACTIVITY_ROW_POLICY, session_id: SESSION, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, context_policy: TEXT_ROW_POLICY, session_id: SESSION, role: 'assistant', kind: 'text', content: id, round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }

function validHistory(overrides: { requiredModelFactsOverride?: Record<string, unknown>; dispositionsOverride?: Partial<CompactedHistory['dispositionCommitment']> } = {}): CompactedHistory {
  const groups = [{ message_ids: ['activation', 'tail'], content_sha256: 'b'.repeat(64) }];
  return {
    summaryText: 'accumulated prose',
    source: { kind: 'current_rows', groups },
    dispositionCommitment: { sha256: 'c'.repeat(64), count: 2, summarized: 2, evidenceOnly: 0, superseded: 0, ...overrides.dispositionsOverride },
    coverageCommitment: { sourceSessionId: SESSION, sourceVersion: 3, coveredThroughMessageId: 'tail', coveredSourceGroupsSha256: coveredSourceGroupsSha256(groups), accumulatedSummarySha256: accumulatedSummarySha256('accumulated prose') },
    requiredModelFacts: {
      latestRecovery: { sourceMessageId: `${INPUT}:model-recovered`, activationInputId: INPUT },
      latestContentPolicyRefusal: { markerId: MARKER_ID, activationInputId: INPUT },
      ...overrides.requiredModelFactsOverride,
    },
  };
}
