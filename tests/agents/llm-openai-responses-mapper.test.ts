import { describe, expect, it } from '@jest/globals';
import { responsesInputFromProviderConversation } from '../../src/agents/llm-openai-responses-mapper.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { RESPONSES_A, RESPONSES_B, responsesBundle } from '../helpers/responses-producer-fixture.js';

const TS = '2026-01-01T00:00:00.000Z';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const PRODUCER = responsesProducerAccountId({ provider: 'openai', account: null });
const base = { context_policy: TEXT_ROW_POLICY, session_id: 'agent:analyst:global' as const, round_id: 'r-user-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: TS };

describe('OpenAI Responses provider conversation mapper', () => {
  it('uses local provider/account identity, excluding model and distinguishing null and explicit aliases', () => {
    const identity = responsesProducerAccountId(RESPONSES_A);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    const otherModel = { ...RESPONSES_A, model: 'other' };
    expect(responsesProducerAccountId(otherModel)).toBe(identity);
    for (const candidate of [RESPONSES_B, { ...RESPONSES_A, provider: 'other' }, { ...RESPONSES_A, account: null }])
      expect(responsesProducerAccountId(candidate)).not.toBe(identity);
  });

  it('filters each mixed producer independently while preserving native items, results and source bytes', () => {
    const rows = [
      ...responsesBundle(base.session_id, SOURCE, RESPONSES_A, '{"success":false,"error":"failed"}'),
      ...responsesBundle(base.session_id, '22222222-2222-4222-8222-222222222222', RESPONSES_B, '{"success":true,"data":"ok"}'),
    ];
    const original = JSON.stringify(rows);
    const projection = providerConversationFromComposedContext(composeContextProjection({ sourceSessionId: base.session_id, effectiveHistory: null, dynamicBlocks: [], uncoveredRows: rows }));
    const projectionBefore = JSON.stringify(projection);
    for (const candidate of [RESPONSES_A, RESPONSES_B]) {
      const expected = [0, 3].flatMap((offset) => {
        const content = JSON.parse(rows[offset]!.content);
        return [...content.output.filter((item: { type: string; encrypted_content?: string }) => content.producer_account_id === responsesProducerAccountId(candidate) || !(item.type === 'reasoning' && Object.hasOwn(item, 'encrypted_content'))), { type: 'function_call_output', call_id: rows[offset + 2]!.tool_call_id, output: rows[offset + 2]!.content }];
      });
      expect(responsesInputFromProviderConversation(projection, responsesProducerAccountId(candidate)).slice(-expected.length)).toEqual(expected);
      expect(JSON.stringify(rows)).toBe(original);
      expect(JSON.stringify(projection)).toBe(projectionBefore);
    }
  });
  it('maps private output unchanged and appends a matching failed function_call_output unchanged', () => {
    const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }];
    const privateRow: AgentMessage = { ...base, context_policy: { kind: 'structural', behavior: 'responses_private' }, id: `${SOURCE}:provider-private:openai-responses`, role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', producer_account_id: PRODUCER, source_input_id: SOURCE, projection_message_id: `${SOURCE}:tool-call:call-1`, provider: 'openai', model: 'gpt-5.6', output }) };
    const visible: AgentMessage = { ...base, context_policy: toolRowPolicies({ content: '' }).call, id: `${SOURCE}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }), tool: 'read_file', tool_call_id: 'call-1', provider_projection: { kind: 'openai_responses', source_input_id: SOURCE, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' } };
    const failedContent = '{"success":false,"error":"read failed"}';
    const result: AgentMessage = { ...base, context_policy: toolRowPolicies({ content: failedContent, settlementOrigin: 'execution_failed' }).result, id: `${SOURCE}:tool-result:call-1`, role: 'tool', kind: 'tool_result', content: failedContent, tool: 'read_file', tool_call_id: 'call-1' };

    const composed = composeContextProjection({ sourceSessionId: base.session_id, effectiveHistory: null, dynamicBlocks: [], uncoveredRows: [privateRow, visible, result] });
    const input = responsesInputFromProviderConversation(providerConversationFromComposedContext(composed), PRODUCER);
    expect(input.slice(-3)).toEqual([...output, { type: 'function_call_output', call_id: 'call-1', output: failedContent }]);
  });

  it('does not require private rows for unmarked generic assistant history', () => {
    const visible: AgentMessage = { ...base, id: 'm1', role: 'assistant', kind: 'text', content: 'generic' };
    expect(responsesInputFromProviderConversation({ sourceSessionId: 'agent:analyst:global', messages: [visible] }, PRODUCER)).toEqual([{ role: 'assistant', content: [{ type: 'output_text', text: 'generic' }] }]);
  });

  it('fails on marked visible row without matching private row', () => {
    const visible: AgentMessage = { ...base, id: 'input-1:message', role: 'assistant', kind: 'text', content: 'x', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: 'missing', projection_kind: 'assistant_message' } };
    for (const identity of [PRODUCER, responsesProducerAccountId(RESPONSES_B)])
      expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'agent:analyst:global', messages: [visible] }, identity)).toThrow(/missing private row/);
  });

  it('composition admission rejects orphan private rows, duplicate private rows, and mismatched bidirectional ids', () => {
    const output = [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }];
    const privateRow: AgentMessage = { ...base, context_policy: { kind: 'structural', behavior: 'responses_private' }, id: 'input-1:provider-private:openai-responses', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', producer_account_id: PRODUCER, source_input_id: 'input-1', projection_message_id: 'input-1:message', provider: 'openai', model: 'gpt-5.6', output }) };
    const duplicatePrivate: AgentMessage = { ...privateRow, id: 'input-1:provider-private:openai-responses:duplicate' };
    const visible: AgentMessage = { ...base, id: 'input-1:message', role: 'assistant', kind: 'text', content: 'x', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: privateRow.id, projection_kind: 'assistant_message' } };

    const compose = (uncoveredRows: AgentMessage[], sourceSessionId = base.session_id as AgentMessage['session_id']) => composeContextProjection({ sourceSessionId, uncoveredRows, effectiveHistory: null, dynamicBlocks: [] });
    expect(() => compose([privateRow])).toThrow(/missing marked visible projection/);
    expect(() => compose([privateRow, duplicatePrivate, visible])).toThrow(/duplicated/);
    expect(() => compose([privateRow, { ...visible, provider_projection: { ...visible.provider_projection!, private_message_id: 'wrong-private' } }])).toThrow(/missing private row/);
    expect(() => compose([privateRow, visible], 'agent:planner:project')).toThrow(/not source session 'agent:planner:project'/);
  });
});
