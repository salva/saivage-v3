import { describe, expect, it } from '@jest/globals';
import { responsesInputFromProviderConversation } from '../../src/agents/llm-openai-responses-mapper.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const base = { session_id: 'analyst:global' as const, round_id: 'r-user-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: TS };

describe('OpenAI Responses provider conversation mapper', () => {
  it('maps private output unchanged and appends a matching failed function_call_output unchanged', () => {
    const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }];
    const privateRow: AgentMessage = { ...base, id: `${SOURCE}:provider-private:openai-responses`, role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: SOURCE, projection_message_id: `${SOURCE}:tool-call:call-1`, provider: 'openai', model: 'gpt-5.6', output }) };
    const visible: AgentMessage = { ...base, id: `${SOURCE}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }), tool: 'read_file', tool_call_id: 'call-1', provider_projection: { kind: 'openai_responses', source_input_id: SOURCE, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' } };
    const failedContent = '{"success":false,"error":"read failed"}';
    const result: AgentMessage = { ...base, id: `${SOURCE}:tool-result:call-1`, role: 'tool', kind: 'tool_result', content: failedContent, tool: 'read_file', tool_call_id: 'call-1' };

    expect(responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [privateRow, visible, result] })).toEqual([...output, { type: 'function_call_output', call_id: 'call-1', output: failedContent }]);
  });

  it('does not require private rows for unmarked generic assistant history', () => {
    const visible: AgentMessage = { ...base, id: 'm1', role: 'assistant', kind: 'text', content: 'generic' };
    expect(responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [visible] })).toEqual([{ role: 'assistant', content: [{ type: 'output_text', text: 'generic' }] }]);
  });

  it('fails on marked visible row without matching private row', () => {
    const visible: AgentMessage = { ...base, id: 'input-1:message', role: 'assistant', kind: 'text', content: 'x', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: 'missing', projection_kind: 'assistant_message' } };
    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [visible] })).toThrow(/missing private row/);
  });

  it('rejects compaction metadata instead of filtering it at the gateway', () => {
    const metadata: AgentMessage = { ...base, id: 'c1', role: 'system', kind: 'context_compaction', content: '{}' };
    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [metadata] })).toThrow(/contains compaction metadata/);
  });

  it('fails on orphan private rows, duplicate private rows, and mismatched bidirectional ids', () => {
    const output = [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }];
    const privateRow: AgentMessage = { ...base, id: 'input-1:provider-private:openai-responses', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: 'input-1', projection_message_id: 'input-1:message', provider: 'openai', model: 'gpt-5.6', output }) };
    const duplicatePrivate: AgentMessage = { ...privateRow, id: 'input-1:provider-private:openai-responses:duplicate' };
    const visible: AgentMessage = { ...base, id: 'input-1:message', role: 'assistant', kind: 'text', content: 'x', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: privateRow.id, projection_kind: 'assistant_message' } };

    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [privateRow] })).toThrow(/missing marked visible projection/);
    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [privateRow, duplicatePrivate, visible] })).toThrow(/duplicated/);
    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'analyst:global', messages: [privateRow, { ...visible, provider_projection: { ...visible.provider_projection!, private_message_id: 'wrong-private' } }] })).toThrow(/missing private row/);
    expect(() => responsesInputFromProviderConversation({ sourceSessionId: 'planner:project', messages: [privateRow, visible] })).toThrow(/not source session 'planner:project'/);
  });
});
