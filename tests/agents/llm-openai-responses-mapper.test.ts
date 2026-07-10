import { describe, expect, it } from '@jest/globals';
import { buildResponsesReplayProjection, responsesInputFromReplay } from '../../src/agents/llm-openai-responses-mapper.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const TS = '2026-01-01T00:00:00.000Z';
const base = { session_id: 's1', round_id: 'r-user-00000000000000000000000000000000', message_index: 1, block_index: 0, timestamp: TS };

describe('OpenAI Responses replay mapper', () => {
  it('replays private output unchanged and appends matching function_call_output', () => {
    const output = [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' }];
    const privateRow: AgentMessage = { ...base, id: 'input-1:provider-private:openai-responses', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: 'input-1', projection_message_id: 'input-1:tool-call:call-1', provider: 'openai', model: 'gpt-5.6', output }) };
    const visible: AgentMessage = { ...base, id: 'input-1:tool-call:call-1', role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }), tool: 'read_file', tool_call_id: 'call-1', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' } };
    const result: AgentMessage = { ...base, id: 'input-1:tool:0:tool-result:call-1', role: 'tool', kind: 'tool_result', content: '{"ok":true}', tool: 'read_file', tool_call_id: 'call-1' };

    expect(responsesInputFromReplay(buildResponsesReplayProjection('s1', [privateRow, visible, result]))).toEqual([...output, { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' }]);
  });

  it('does not require private rows for unmarked generic assistant history', () => {
    const visible: AgentMessage = { ...base, id: 'm1', role: 'assistant', kind: 'text', content: 'generic' };
    expect(responsesInputFromReplay(buildResponsesReplayProjection('s1', [visible]))).toEqual([{ role: 'assistant', content: [{ type: 'output_text', text: 'generic' }] }]);
  });

  it('fails on marked visible row without matching private row', () => {
    const visible: AgentMessage = { ...base, id: 'input-1:message', role: 'assistant', kind: 'text', content: 'x', provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: 'missing', projection_kind: 'assistant_message' } };
    expect(() => buildResponsesReplayProjection('s1', [visible])).toThrow(/missing private row/);
  });
});
