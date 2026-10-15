import { describe, expect, it } from '@jest/globals';

import { deriveRequiredModelFacts, validateAtomicCoveredSourcePrefix, validateCompactedHistorySuccessor, validateConversation } from '../../src/contracts/conversation-validation.js';
import { RESPONSES_A, responsesBundle } from '../helpers/responses-producer-fixture.js';
import { agentMessageSchema, compactedHistorySchema, STRUCTURAL_ROW_POLICY, type AgentMessage, type CompactedHistory, type ConversationSessionId, type LatestRecordObservation, type RecordObservation, type RequiredModelFactSlots, type ToolSettlementOrigin } from '../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { historicalOpaqueToolResults } from '../fixtures/historical-opaque-tool-results.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { toolContentSucceeded } from '../../src/contracts/index.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';

const SESSION = 'agent:planner:project' as const;
describe('canonical conversation validation', () => {
  it('preserves early envelope, pairing, commitment, image semantics and evidence failure precedence', () => {
    const malformed = exchange('{"success":true,"extra":1}', 'view_image');
    expect(() => validateConversation(SESSION, [activation(), malformed[1]])).toThrow(/has malformed content:/);
    const missingImage = exchange('{"success":true}', 'view_image');
    expect(() => validateConversation(SESSION, [activation(), missingImage[1]])).toThrow(/no matching earlier call/);
    const wrongCommitment = agentMessageSchema.parse({ ...missingImage[1], context_policy: { ...missingImage[1].context_policy, call_policy_sha256: 'f'.repeat(64) } });
    expect(() => validateConversation(SESSION, [activation(), missingImage[0], wrongCommitment])).toThrow(/does not commit to its call's policy template hash/);
    const wrongEvidence = agentMessageSchema.parse({ ...missingImage[1], context_policy: { ...missingImage[1].context_policy, evidence: { kind: 'observational_query', observedSha256: 'f'.repeat(64) } } });
    expect(() => validateConversation(SESSION, [activation(), missingImage[0], wrongEvidence])).toThrow(`Tool result '${missingImage[1].id}' has malformed content: Successful view_image requires exactly one image block.`);
    // Strict identities make logical duplicates physical duplicates as well; do not forge IDs.
    const valid = exchange('{"success":true}');
    expect(() => validateConversation(SESSION, [activation(), ...valid, valid[1]])).toThrow('Conversation contains duplicate message ids.');
    expect(() => validateConversation(SESSION, [activation(), valid[0], valid[0]])).toThrow('Conversation contains duplicate message ids.');
    expect(() => agentMessageSchema.parse({ ...valid[1], id: `${valid[1].id}:distinct` })).toThrow();
  });

  it.each(['{"success":true,"extra":1}', '{"success":true,"content":[]}', '{"success":false,"error":"failed","content":[{"type":"text","text":"no"}]}', '{"success":true,"content":[{"type":"image","image":{"id":"invalid"}}]}'])('rejects malformed embedded result %s at the early owning parser', content => {
    const [call, result] = exchange(content);
    expect(() => validateConversation(SESSION, [activation(), call, result])).toThrow(/has malformed content:/);
  });

  it('preserves role, source identity and declared evidence requirements', () => {
    const [call, result] = exchange('{"success":true}');
    expect(() => validateConversation(SESSION, [activation(), result, call])).toThrow(/no matching earlier call/);
    const otherSource = agentMessageSchema.parse({ ...result, id: result.id.replace(INPUT, OTHER_INPUT) });
    expect(() => validateConversation(SESSION, [activation(), call, otherSource])).toThrow(/no matching earlier call/);
    const wrongRole = agentMessageSchema.parse({ ...result, role: 'assistant' });
    expect(() => validateConversation(SESSION, [activation(), call, wrongRole])).toThrow(/must use tool role/);
    expect(() => agentMessageSchema.parse({ ...result, content: '{invalid', context_policy: toolRowPolicies({ content: '{invalid' }).result })).toThrow(/exact settled strict ToolResult bytes/);
    const observationalCall = agentMessageSchema.parse({ ...call, context_policy: toolRowPolicies({ content: result.content, template: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE }).call });
    const observationalPolicies = toolRowPolicies({ content: result.content, template: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE });
    const missingEvidence = agentMessageSchema.parse({ ...result, context_policy: observationalPolicies.result });
    expect(() => validateConversation(SESSION, [activation(), observationalCall, missingEvidence])).toThrow(/must carry exactly its call's declared 'observational_query' evidence/);
    const [failedCall, failed] = exchange('{"success":false,"error":"failed"}');
    expect(() => agentMessageSchema.parse({ ...failed, context_policy: { ...failed.context_policy, evidence: { kind: 'observational_query', observedSha256: 'f'.repeat(64) } } })).toThrow(/must carry none evidence/);
    expect(validateConversation(SESSION, [activation(), failedCall, failed]).calls[0]!.resultSourceIndex).toBe(2);
  });

  it.each(['{"success":true,"data":"text"}', '{"success":false,"error":"interrupted"}'])('materializes settled source order, call indexes, repair segments and atomic boundaries for %s', content => {
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, content).map(row => agentMessageSchema.parse(row));
    const rows = [activation(), ...bundle, text('tail')];
    const conversation = validateConversation(SESSION, rows);
    expect(conversation.sourceRows).toEqual(rows);
    expect(conversation.calls).toMatchObject([{ sourceIndex: 2, physicalIndex: 2, resultSourceIndex: 3 }]);
    expect(conversation.unmatchedCall).toBeNull();
    expect(conversation.safeSourcePrefixEnds).toEqual([1, 4, 5]);
    expect(conversation.rounds[0]!.segments.map(segment => ({ kind: segment.kind, ids: segment.rows.map(row => row.id) }))).toEqual(
      JSON.parse(content).success
        ? [{ kind: 'initial', ids: rows.map(row => row.id) }]
        : [{ kind: 'initial', ids: rows.slice(0, 3).map(row => row.id) }, { kind: 'repair', ids: rows.slice(3).map(row => row.id) }],
    );
  });
  it('accepts producer-neutral executed images while preserving view_image metadata and exchange commitments', () => {
    const image = { id: '11111111-1111-4111-8111-111111111111', mime_type: 'image/png' as const, width: 10, height: 5, byte_length: 100, sha256: 'a'.repeat(64) };
    const dimensions = { width: 10, height: 5 };
    const data = { source_path: 'screen.png', source_dimensions: dimensions, oriented_dimensions: dimensions, sent_dimensions: dimensions, orientation_applied: false, resized: false, scale: { x: 1, y: 1 }, max_dimension: 1600 };
    const content = settleToolActionOutcome(toolContentSucceeded(data, [{ type: 'image', image }])).settledResultBytes;
    const rowsFor = (tool: string, resultContent = content, settlementOrigin: ToolSettlementOrigin = 'executed'): AgentMessage[] => {
      const policies = toolRowPolicies({ content: resultContent, settlementOrigin });
      return [activation(), {
        id: `${INPUT}:tool-call:image`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool, tool_call_id: 'image', context_policy: policies.call,
        content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'image', type: 'function', function: { name: tool, arguments: '{"path":"screen.png"}' } }] }), round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-10-07T00:00:01.000Z',
      }, {
        id: `${INPUT}:tool-result:image`, session_id: SESSION, role: 'tool', kind: 'tool_result', tool, tool_call_id: 'image', context_policy: policies.result, content: resultContent,
        round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 2, block_index: 0, timestamp: '2026-10-07T00:00:02.000Z',
      }];
    };
    expect(() => validateConversation(SESSION, rowsFor('view_image'))).not.toThrow();
    const alternateContent = settleToolActionOutcome(toolContentSucceeded({ caption: 'fixture' }, [{ type: 'image', image }])).settledResultBytes;
    const alternate = rowsFor('fixture_image_producer', alternateContent);
    expect(() => validateConversation(SESSION, alternate)).not.toThrow();
    for (const rows of [rowsFor('view_image'), alternate]) {
      const conversation = validateConversation(SESSION, rows.map(row => agentMessageSchema.parse(row)));
      expect(conversation.sourceRows).toEqual(rows);
      expect(conversation.calls).toMatchObject([{ sourceIndex: 1, physicalIndex: 1, resultSourceIndex: 2 }]);
      expect(conversation.safeSourcePrefixEnds).toEqual([1, 3]);
      expect(conversation.rounds[0]!.segments.map(segment => segment.kind)).toEqual(['initial']);
    }
    for (const origin of ['rejected_before_execution', 'unsupported_tool', 'execution_failed'] as const)
      expect(() => validateConversation(SESSION, rowsFor('fixture_image_producer', alternateContent, origin))).toThrow();
    expect(() => validateConversation(SESSION, [alternate[0]!, alternate[1]!, { ...alternate[2]!, tool: 'different' }])).toThrow();
    expect(() => validateConversation(SESSION, [alternate[0]!, alternate[1]!, { ...alternate[2]!, tool_call_id: 'different' }])).toThrow();
    expect(() => agentMessageSchema.parse({ ...alternate[2]!, content: alternateContent.replace('fixture', 'changed') })).toThrow();
    const wrongPolicy = structuredClone(alternate);
    if (wrongPolicy[2]!.context_policy.kind !== 'tool_result') throw new Error('Expected result policy.');
    wrongPolicy[2]!.context_policy.call_policy_sha256 = 'f'.repeat(64);
    expect(() => validateConversation(SESSION, wrongPolicy)).toThrow();
    const wrongEvidence = structuredClone(alternate);
    if (wrongEvidence[2]!.context_policy.kind !== 'tool_result') throw new Error('Expected result policy.');
    wrongEvidence[2]!.context_policy.evidence = { kind: 'observational_query', observedSha256: 'f'.repeat(64) };
    expect(() => validateConversation(SESSION, wrongEvidence)).toThrow();
    expect(() => validateConversation(SESSION, rowsFor('view_image', content, 'rejected_before_execution'))).toThrow();
    expect(() => validateConversation(SESSION, rowsFor('view_image', JSON.stringify({ success: false, error: 'failed', content: [{ type: 'image', image }] })))).toThrow(/malformed/);
    expect(() => validateConversation(SESSION, rowsFor('view_image', '{"success":true}'))).toThrow(/requires exactly one image block/);
    for (const blocks of [[{ type: 'text', text: 'not an image' }], [{ type: 'image', image }, { type: 'image', image }]]) {
      const rows = rowsFor('view_image', JSON.stringify({ success: true, data, content: blocks })).map(row => agentMessageSchema.parse(row));
      expect(() => validateConversation(SESSION, rows)).toThrow(/requires exactly one image block/);
    }
    expect(() => validateConversation(SESSION, rowsFor('view_image', JSON.stringify({ success: true, data: { ...data, sent_dimensions: { width: 9, height: 5 } }, content: [{ type: 'image', image }] })))).toThrow(/malformed/);
    const differentDimensions = { width: 9, height: 5 };
    expect(() => validateConversation(SESSION, rowsFor('view_image', JSON.stringify({ success: true, data: { ...data, source_dimensions: differentDimensions, oriented_dimensions: differentDimensions, sent_dimensions: differentDimensions }, content: [{ type: 'image', image }] })))).toThrow(/consistent strict view_image/);
    expect(() => validateConversation(SESSION, rowsFor('view_image', '{"success":false,"error":"interrupted"}'))).not.toThrow();
    for (const invalid of [undefined, { ...data, extra: true }, { ...data, scale: { x: 0.5, y: 1 } }, { ...data, resized: true }, { ...data, oriented_dimensions: { width: 5, height: 10 } }]) {
      expect(() => validateConversation(SESSION, rowsFor('view_image', JSON.stringify({ success: true, data: invalid, content: [{ type: 'image', image }] })))).toThrow(/malformed/);
    }
  });
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

  it('admits only a nonempty contiguous source prefix with complete settled tool/private bundles', () => {
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, '{"success":true,"data":"settled"}');
    const rows = [activation(), ...bundle, text('tail')];
    const conversation = validateConversation(SESSION, rows);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, rows.slice(0, 4))).not.toThrow();
    expect(() => validateAtomicCoveredSourcePrefix(conversation, [])).toThrow(/requires source rows/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, rows.slice(1, 4))).toThrow(/contiguous/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, [rows[0]!, rows[2]!, rows[1]!, rows[3]!])).toThrow(/contiguous/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, [rows[0]!, rows[0]!])).toThrow(/contiguous/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, [text('unknown')])).toThrow(/not a source row/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, rows.slice(0, 2))).toThrow(/split/);
    expect(() => validateAtomicCoveredSourcePrefix(conversation, rows.slice(0, 3))).toThrow(/split/);

    const ordinary = [activation(), { ...bundle[1]!, provider_projection: undefined }, bundle[2]!];
    const ordinaryConversation = validateConversation(SESSION, ordinary);
    expect(() => validateAtomicCoveredSourcePrefix(ordinaryConversation, ordinary.slice(0, 2))).toThrow(/split/);
    expect(() => validateAtomicCoveredSourcePrefix(ordinaryConversation, ordinary)).not.toThrow();
    const unmatched = validateConversation(SESSION, ordinary.slice(0, 2));
    expect(unmatched.unmatchedCall?.message.id).toBe(bundle[1]!.id);
    expect(() => validateAtomicCoveredSourcePrefix(unmatched, ordinary.slice(0, 2))).toThrow(/complete settled exchange/);
    expect(() => validateConversation(SESSION, [...ordinary.slice(0, 2), text('after-unmatched')])).toThrow(/non-final unmatched/);
  });

  it('materializes self-contained compacted history and inherited open round on read', () => {
    const history = validHistory() as CompactedHistory;
    const conversation = validateConversation(SESSION, [], { markerId: 'activation', inputId: INPUT, activeSegmentKind: 'initial', startOrdinal: 0 }, { id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history, sourceVersion: 3 });
    expect(conversation.effectiveCompactedHistory).toEqual(history);
    expect(conversation.rounds[0]!.rows).toEqual([]);
    expect(conversation.effectiveRequiredModelFacts).toEqual(history.requiredModelFacts);
    expect(conversation.compactedGenesis).toEqual({ id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z' });
  });

  it('rejects removed compacted history fields', () => {
    const history = validHistory();
    for (const field of ['source', 'coverageCommitment', 'dispositionCommitment']) {
      expect(compactedHistorySchema.safeParse({ ...history, [field]: {} }).success).toBe(false);
    }
  });

  it('strictly validates protected-list sessions, ids, coordinates, policies, and suffix disjointness at current read', () => {
    const first = protectedText('protected-a', 'instruction a');
    const second = protectedText('protected-b', 'instruction b');
    const valid = historyWithProtected([
      { source: { segmentVersion: 1, rowIndex: 2 }, message: first },
      { source: { segmentVersion: 2, rowIndex: 0 }, message: second },
    ]);
    const seed = (history: CompactedHistory) => ({ id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', history, sourceVersion: 3 } as const);
    expect(validateConversation(SESSION, [], undefined, seed(valid)).effectiveCompactedHistory?.protectedPrompts).toHaveLength(2);

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
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: { sourceMessageId: `${INPUT}:other`, activationInputId: INPUT }, latestContentPolicyRefusal: null, latestRecordObservations: [] } }))).toThrow(/activation-derived recovery identity/);
    expect(() => compactedHistorySchema.parse(validHistory({ requiredModelFactsOverride: { latestRecovery: null, latestContentPolicyRefusal: { markerId: 'not-a-uuid', activationInputId: INPUT } } }))).toThrow();
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
        options: { providerSessionId: 'synthetic-provider-session', inputId, contract_id: 'test.v1', contractName: 'test', tools: [], tool_choice: 'auto', terminalToolOffered: [], temperature: 0, max_tokens: 10 },
        capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] },
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

function exchange(content: string, tool = 'fixture_tool'): [AgentMessage, AgentMessage] {
  const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, content);
  const callId = bundle[1]!.tool_call_id!;
  return [agentMessageSchema.parse({ ...bundle[1], provider_projection: undefined, tool,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: '{}' } }] }),
  }), agentMessageSchema.parse({ ...bundle[2], tool })];
}

const EMPTY_FACTS: RequiredModelFactSlots = { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] };

describe('record observation source derivation', () => {
  it.each([256, 1024])('bounds identity access linearly for %i canonical rows and selected subsets', (size) => {
    // Count only accesses after valid, linearly constructed fixtures are ready.
    // Dense coverage also rejects moving a quadratic search behind an observation filter.
    for (const density of ['none', 'sparse', 'dense'] as const) {
      let accesses = 0;
      const rows = Array.from({ length: size }, (_, index) => {
        const row = density === 'dense' || (density === 'sparse' && index % 64 === 0)
          ? observationRow(`observed-${index}`, [observation('brief.md', index + 1)])
          : text(`text-${index}`);
        const id = row.id;
        Object.defineProperty(row, 'id', { enumerable: true, get: () => { accesses++; return id; } });
        return row;
      });
      const source = validateConversation(SESSION, rows);
      expect(accesses).toBeLessThanOrEqual(32 * size);
      expect(source.effectiveRequiredModelFacts.latestRecordObservations).toEqual(
        density === 'none' ? [] : [fact(rows[density === 'dense' ? size - 1 : size - 64]!, density === 'dense' ? size - 1 : size - 64)],
      );
      const subset = rows.slice(size / 2);
      accesses = 0;
      const facts = deriveRequiredModelFacts({ inherited: EMPTY_FACTS, coveredRows: subset, source });
      expect(accesses).toBeLessThanOrEqual(8 * size);
      expect(facts).toEqual(source.effectiveRequiredModelFacts);
    }
  });

  it('preserves zero and nonzero canonical coordinates for copied-ID subsets with private rows', () => {
    const first = observationRow('first', [observation('brief.md', 1)]);
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, '{"success":true,"data":"settled"}');
    const last = agentMessageSchema.parse({ ...text('last'), role: 'user', kind: 'record_prompt',
      instruction_origin: 'workflow_prompt', record_prompt: { reference: 'changed-record', node_id: 'plan', reason: 'changed' },
      record_observations: [{ ...observation('status.md', 2), source: { kind: 'prompt', input_id: INPUT, node_id: 'plan', reference: 'changed-record' } }] });
    const rows = [first, activation(), ...bundle, last];
    const source = validateConversation(SESSION, rows);
    expect(source.sourceRows.map(row => row.id)).toEqual(rows.map(row => row.id));
    // Private rows remain canonical source rows, unlike provider-visible offsets.
    const visibleOffset = providerConversationProjection(source, []).messages.filter(row => row.kind !== 'provider_private').findIndex(row => 'id' in row && row.id === last.id);
    expect(visibleOffset).toBeGreaterThanOrEqual(0);
    expect(visibleOffset).toBeLessThan(5);
    const copiedLast = agentMessageSchema.parse({ ...last, timestamp: '2026-08-11T00:00:09.000Z',
      record_observations: last.record_observations!.map(entry => ({ ...entry, observed: { ...entry.observed, exposure: { kind: 'reference_only' } } })) });
    const facts = deriveRequiredModelFacts({ inherited: EMPTY_FACTS, coveredRows: [copiedLast, { ...first }], source });
    expect(facts.latestRecordObservations).toEqual([fact(copiedLast, 5), fact(first, 0)]);
    expect(facts.latestRecordObservations[0]!.observation).toBe(copiedLast.record_observations![0]);
    for (const unknown of [text('unknown-empty'), observationRow('unknown-observed', [observation('brief.md', 1)])]) {
      expect(() => deriveRequiredModelFacts({ inherited: EMPTY_FACTS, coveredRows: [unknown], source })).toThrow('Record observation row is not in its canonical source.');
    }
  });

  it('preserves inherited coordinates, latest occurrence order, historical exclusion and covered successor facts', () => {
    const inheritedA = fact(observationRow('inherited-a', [observation('brief.md', 9)]), 17, 1);
    const inheritedB = fact(observationRow('inherited-b', [observation('status.md', 8)]), 23, 2);
    const inherited = { ...EMPTY_FACTS, latestRecordObservations: [inheritedA, inheritedB] };
    const history = compactedHistorySchema.parse({ summaryText: 'prior', protectedPrompts: [], requiredModelFacts: inherited });
    const a = observationRow('a', [observation('brief.md', 2)]);
    const b = observationRow('b', [observation('status.md', 3)]);
    const ac = observationRow('ac', [observation('brief.md', 1), observation('review.md', 1)]);
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, '{"success":true,"data":"historical"}');
    const result = bundle[2]!;
    result.record_observations = [{
      ...observation('brief.md', 7),
      observed: { ...observation('brief.md', 7).observed, selection_kind: 'historical', head: null },
      source: { kind: 'read', input_id: INPUT, tool_call_id: result.tool_call_id!, tool_name: result.tool! },
    }];
    bundle[2] = agentMessageSchema.parse(result);
    const rows = [a, b, ac, activation(), ...bundle];
    const source = validateConversation(SESSION, rows, undefined, { id: GENESIS_ID, timestamp: '2026-08-18T00:00:00.000Z', sourceVersion: 3, history });
    expect(source.segmentVersion).toBe(4);
    expect(source.effectiveRequiredModelFacts.latestRecordObservations).toEqual([fact(b, 1, 4), fact(ac, 2, 4), fact(ac, 2, 4, 1)]);
    const coveredRows = [a];
    const facts = deriveRequiredModelFacts({ inherited, coveredRows, source });
    expect(facts.latestRecordObservations).toEqual([inheritedB, fact(a, 0, 4)]);
    expect(facts.latestRecordObservations[0]).toBe(inheritedB);
    const successor = compactedHistorySchema.parse({ summaryText: 'covered', protectedPrompts: [], requiredModelFacts: facts });
    expect(() => validateCompactedHistorySuccessor({ source, sourceVersion: 4, successor, coveredRows })).not.toThrow();
    expect(deriveRequiredModelFacts({ inherited, coveredRows: rows, source })).toEqual(source.effectiveRequiredModelFacts);
    expect(() => deriveRequiredModelFacts({ inherited, coveredRows: [{ ...bundle[2]!, id: 'unknown-historical' }], source })).toThrow('Record observation row is not in its canonical source.');
  });

  it('strictly consumes malformed and duplicate rows outside the observation selection', () => {
    const selected = observationRow('selected', [observation('brief.md', 1)]);
    const bundle = responsesBundle(SESSION, INPUT, RESPONSES_A, '{"success":true,"data":"settled"}');
    expect(() => validateConversation(SESSION, [selected, text('duplicate'), text('duplicate')])).toThrow(/duplicate message ids/);
    expect(() => validateConversation(SESSION, [selected, activation(), ...bundle.slice(0, 2), { ...bundle[2]!, content: '{malformed' }])).toThrow(/malformed content/);
  });
});

function observation(recordName: string, version: number): RecordObservation {
  return {
    observed: { card_id: 'project', record_name: recordName, view: 'accepted', selection_kind: 'current',
      head: { head_id: INPUT, revision: version },
      selection: { kind: 'accepted', entry_id: GENESIS_ID, version, locator: `record:///${recordName}?card=project&v=${version}`, content_sha256: 'a'.repeat(64) },
      exposure: { kind: 'metadata' } },
    source: { kind: 'preparation', input_id: INPUT, node_id: 'plan' },
  };
}

function observationRow(id: string, observations: RecordObservation[]): AgentMessage {
  return agentMessageSchema.parse({ ...text(id), role: 'system', kind: 'record_observation', content: '',
    context_policy: STRUCTURAL_ROW_POLICY.record_observation, record_observations: observations });
}

function fact(row: AgentMessage, rowIndex: number, segmentVersion = 1, observationIndex = 0): LatestRecordObservation {
  return { source: { segmentVersion, rowIndex, messageId: row.id, timestamp: row.timestamp }, observation: row.record_observations![observationIndex]! };
}

function activation(id = 'activation', inputId = INPUT): AgentMessage { const timestamp = '2026-08-11T00:00:00.000Z'; return agentMessageSchema.parse({ id, context_policy: ACTIVITY_ROW_POLICY, session_id: SESSION, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' }, agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }); }

describe('strict activation instruction evidence', () => {
  it('requires explicit evidence and rejects unknown fields or mismatched identities at canonical consumption', () => {
    const marker = activation();
    const payload = JSON.parse(marker.content);
    expect(agentMessageSchema.parse(marker)).toEqual(marker);
    const {instructions: _instructions, ...missing} = payload;
    const invalid = [missing, {...payload,card_id:'card-a'}, {...payload,agent_name:'executor'},
      {...payload,instructions:{kind:'prepared',role_text:'role',node:null}},
      {...payload,instructions:{kind:'prepared',role_text:'role',node:{node_id:'plan',text:'node',private:'sentinel'}}},
      {...payload,instructions:{kind:'unavailable',reason:'unknown'}},
      {...payload,instructions:{kind:'not_applicable',reason:'non_model_ingress'}},
    ];
    for (const value of invalid) expect(() => agentMessageSchema.parse({...marker,content:JSON.stringify(value)})).toThrow();
  });
});
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, context_policy: TEXT_ROW_POLICY, session_id: SESSION, role: 'assistant', kind: 'text', content: id, round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }
function protectedText(id: string, content: string, sessionId: ConversationSessionId = SESSION): AgentMessage { return agentMessageSchema.parse({ id, context_policy: { ...TEXT_ROW_POLICY, compactable: false }, session_id: sessionId, role: 'user', kind: 'text', content, round_id: `r-user-${'2'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:01.000Z' }); }

function validHistory(overrides: { requiredModelFactsOverride?: Record<string, unknown> } = {}): CompactedHistory {
  return {
    summaryText: 'accumulated prose',
    protectedPrompts: [],
    requiredModelFacts: {
      latestRecordObservations: [],
      latestRecovery: { sourceMessageId: `${INPUT}:model-recovered`, activationInputId: INPUT },
      latestContentPolicyRefusal: { markerId: MARKER_ID, activationInputId: INPUT },
      ...overrides.requiredModelFactsOverride,
    },
  };
}

function historyWithProtected(protectedPrompts: CompactedHistory['protectedPrompts']): CompactedHistory {
  const history = validHistory();
  return { ...history, protectedPrompts };
}
