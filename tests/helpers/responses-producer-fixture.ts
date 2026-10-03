import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import type { Candidate } from '../../src/contracts/index.js';
import { STRUCTURAL_ROW_POLICY } from '../../src/schemas/index.js';
import { toolRowPolicies } from './row-policy-fixtures.js';

export const RESPONSES_A: Candidate = { provider: 'responses', account: 'a', model: 'm' };
export const RESPONSES_B: Candidate = { provider: 'responses', account: 'b', model: 'm' };

export function responsesBundle(session: ConversationSessionId, source: string, producer: Candidate, resultContent: string): AgentMessage[] {
  const callId = `call-${source}`;
  const output = [
    { type: 'reasoning', id: `encrypted-${source}`, encrypted_content: `ciphertext-${source}`, summary: [{ type: 'summary_text', text: 'private summary' }] },
    { type: 'reasoning', id: `plain-${source}`, summary: [] },
    { type: 'message', id: `message-${source}`, role: 'assistant', content: [{ type: 'output_text', text: `visible-${source}` }] },
    { type: 'function_call', call_id: callId, name: 'read_file', arguments: '{"path":"a"}' },
  ];
  const base = { session_id: session, round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-10-03T00:00:00.000Z' };
  const policies = toolRowPolicies({ content: resultContent, ...(resultContent.includes('"success":false') ? { settlementOrigin: 'execution_failed' as const } : {}) });
  return [
    { ...base, id: `${source}:private`, role: 'system', kind: 'provider_private', context_policy: STRUCTURAL_ROW_POLICY.responses_private, content: JSON.stringify({ transport: 'openai-responses', producer_account_id: responsesProducerAccountId(producer), source_input_id: source, projection_message_id: `${source}:tool-call:${callId}`, provider: producer.provider, model: producer.model, output }) },
    { ...base, id: `${source}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call', context_policy: policies.call, tool: 'read_file', tool_call_id: callId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }), provider_projection: { kind: 'openai_responses', source_input_id: source, private_message_id: `${source}:private`, projection_kind: 'assistant_tool_call' } },
    { ...base, id: `${source}:tool-result:${callId}`, role: 'tool', kind: 'tool_result', context_policy: policies.result, tool: 'read_file', tool_call_id: callId, content: resultContent },
  ];
}
