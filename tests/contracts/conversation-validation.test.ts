import { describe, expect, it } from '@jest/globals';

import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { accumulatedSummarySha256, agentMessageSchema, compactedHistorySchema, coveredSourceGroupsSha256, protectedPromptsSha256, type AgentMessage, type CompactedHistory, type ConversationSessionId } from '../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { historicalOpaqueToolResults } from '../fixtures/historical-opaque-tool-results.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';

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

  it('strictly validates protected-list hashes, sessions, ids, coordinates, policies, and suffix disjointness at current read', () => {
    const first = protectedText('protected-a', 'instruction a');
    const second = protectedText('protected-b', 'instruction b');
    const valid = historyWithProtected([
      { source: { segmentVersion: 1, rowIndex: 2 }, message: first },
      { source: { segmentVersion: 2, rowIndex: 0 }, message: second },
    ]);
    const seed = (history: CompactedHistory) => ({ id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history, sourceVersion: 3 } as const);
    expect(validateConversation(SESSION, [], undefined, seed(valid)).effectiveCompactedHistory?.protectedPrompts).toHaveLength(2);
    expect(() => validateConversation(SESSION, [], undefined, seed({ ...valid, coverageCommitment: { ...valid.coverageCommitment, protectedPromptsSha256: '0'.repeat(64) } }))).toThrow(/protected prompts hash/);

    const wrongSession = protectedText('protected-other-session', 'instruction', 'agent:planner:card-a');
    expect(() => validateConversation(SESSION, [], undefined, seed(historyWithProtected([{ source: { segmentVersion: 1, rowIndex: 0 }, message: wrongSession }])))).toThrow(/another session/);
    expect(() => validateConversation(SESSION, [], undefined, seed(historyWithProtected([
      { source: { segmentVersion: 1, rowIndex: 0 }, message: first },
      { source: { segmentVersion: 1, rowIndex: 1 }, message: { ...first } },
    ])))).toThrow(/duplicate message ids/);
    expect(() => validateConversation(SESSION, [], undefined, seed(historyWithProtected([
      { source: { segmentVersion: 1, rowIndex: 1 }, message: first },
      { source: { segmentVersion: 1, rowIndex: 1 }, message: second },
    ])))).toThrow(/coordinates are not strictly ordered/);
    expect(() => validateConversation(SESSION, [], undefined, seed(historyWithProtected([{ source: { segmentVersion: 4, rowIndex: 0 }, message: first }])))).toThrow(/source is later/);
    expect(() => validateConversation(SESSION, [], undefined, seed(historyWithProtected([{ source: { segmentVersion: 1, rowIndex: 0 }, message: { ...first, context_policy: TEXT_ROW_POLICY } }])))).toThrow(/not protected-capable/);
    expect(() => validateConversation(SESSION, [first], undefined, seed(historyWithProtected([{ source: { segmentVersion: 1, rowIndex: 0 }, message: first }])))).toThrow(/disjoint/);
  });

  it('rejects malformed required-model-fact slots', () => {
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: { sourceMessageId: `${INPUT}:other`, activationInputId: INPUT }, latestContentPolicyRefusal: null } }))).toThrow(/activation-derived recovery identity/);
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: null, latestContentPolicyRefusal: { markerId: 'not-a-uuid', activationInputId: INPUT } } }))).toThrow();
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: null, latestContentPolicyRefusal: null }, dispositionsOverride: { sha256: 'a'.repeat(64), count: 5, summarized: 2, evidenceOnly: 2, superseded: 2 } }))).toThrow(/sum of its kinds/);
  });

  it('admits historical search arguments and opaque old-array, plaintext-slice, and hex-slice results unchanged', () => {
    for (const [index, fixture] of historicalOpaqueToolResults.filter(({ toolName }) => toolName === 'glob' || toolName === 'grep').entries()) {
      const inputId = `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`;
      const callId = `search-${index}`;
      const argumentsValue = fixture.toolName === 'glob'
        ? { directory: '.', pattern: '**/*', max_results: 0 }
        : { path: '.', pattern: 'needle', max_results: 0 };
      const content = JSON.stringify(fixture.result);
      const policies = toolRowPolicies({ content });
      const rows: AgentMessage[] = [
        activation(`activation-${index}`, inputId),
        { id: `${inputId}:tool-call:${callId}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: fixture.toolName, tool_call_id: callId, context_policy: policies.call, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: fixture.toolName, arguments: JSON.stringify(argumentsValue) } }] }), round_id: `r-assistant-${String(index).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp: '2026-09-09T00:00:01.000Z' },
        { id: `${inputId}:tool-result:${callId}`, session_id: SESSION, role: 'tool', kind: 'tool_result', tool: fixture.toolName, tool_call_id: callId, context_policy: policies.result, content, round_id: `r-assistant-${String(index).padStart(32, '0')}`, message_index: 2, block_index: 0, timestamp: '2026-09-09T00:00:02.000Z' },
      ];
      const validated = validateConversation(SESSION, rows);
      expect(validated.physicalRows[2]!.content).toBe(content);
      expect(JSON.parse(validated.physicalRows[1]!.content).tool_calls[0].function.arguments).toBe(JSON.stringify(argumentsValue));
      const providerConversation = providerConversationProjection(validated, []);
      const request = selectLlmProtocolAdapter('openai-chat-completions').buildRequestBody({
        candidate: { provider: 'openai', model: 'fixture', account: null },
        systemPrompt: 'system',
        providerConversation,
        options: { inputId, contract_id: 'test.v1', contractName: 'test', tools: [], tool_choice: 'auto', terminalToolOffered: [], temperature: 0, max_tokens: 10 },
        capabilities: { transportProtocol: 'openai-chat-completions', toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] },
      });
      const providerResult = (request.messages as Array<{ role: string; content: string; tool_call_id?: string }>).find((message) => message.role === 'tool');
      expect(providerResult?.tool_call_id).toBe(callId);
      expect(JSON.parse(providerResult!.content as string)).toEqual(JSON.parse(providerConversation.messages.find((message) => message.kind === 'tool_result')!.content));
      const sourceHex = content.match(/"content_hex":"([0-9a-f]+)"/u)?.[1];
      expect((providerResult!.content as string).match(/"content_hex":"([0-9a-f]+)"/u)?.[1]).toBe(sourceHex);
    }
  });
});

const INPUT = '00000000-0000-4000-8000-000000000001';
const OTHER_INPUT = '00000000-0000-4000-8000-000000000002';
const GENESIS_ID = '11111111-1111-4111-8111-111111111111';
const MARKER_ID = '22222222-2222-4222-8222-222222222222';

function activation(id = 'activation', inputId = INPUT): AgentMessage { const timestamp = '2026-08-11T00:00:00.000Z'; return agentMessageSchema.parse({ id, context_policy: ACTIVITY_ROW_POLICY, session_id: SESSION, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, context_policy: TEXT_ROW_POLICY, session_id: SESSION, role: 'assistant', kind: 'text', content: id, round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }
function protectedText(id: string, content: string, sessionId: ConversationSessionId = SESSION): AgentMessage { return agentMessageSchema.parse({ id, context_policy: { ...TEXT_ROW_POLICY, compactable: false }, session_id: sessionId, role: 'user', kind: 'text', content, round_id: `r-user-${'2'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }

function validHistory(overrides: { requiredModelFactsOverride?: Record<string, unknown>; dispositionsOverride?: Partial<CompactedHistory['dispositionCommitment']> } = {}): CompactedHistory {
  const groups = [{ message_ids: ['activation', 'tail'], content_sha256: 'b'.repeat(64) }];
  return {
    summaryText: 'accumulated prose',
    source: { kind: 'current_rows', groups },
    dispositionCommitment: { sha256: 'c'.repeat(64), count: 2, summarized: 2, evidenceOnly: 0, superseded: 0, protected: 0, ...overrides.dispositionsOverride },
    coverageCommitment: { sourceSessionId: SESSION, sourceVersion: 3, coveredThroughMessageId: 'tail', coveredSourceGroupsSha256: coveredSourceGroupsSha256(groups), accumulatedSummarySha256: accumulatedSummarySha256('accumulated prose'), protectedPromptsSha256: protectedPromptsSha256([]) },
    protectedPrompts: [],
    requiredModelFacts: {
      latestRecovery: { sourceMessageId: `${INPUT}:model-recovered`, activationInputId: INPUT },
      latestContentPolicyRefusal: { markerId: MARKER_ID, activationInputId: INPUT },
      ...overrides.requiredModelFactsOverride,
    },
  };
}

function historyWithProtected(protectedPrompts: CompactedHistory['protectedPrompts']): CompactedHistory {
  const history = validHistory();
  return { ...history, protectedPrompts, coverageCommitment: { ...history.coverageCommitment, protectedPromptsSha256: protectedPromptsSha256(protectedPrompts) } };
}
