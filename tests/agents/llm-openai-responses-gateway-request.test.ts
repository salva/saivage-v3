import { describe, expect, it } from '@jest/globals';
import { buildOpenAIResponsesRequest } from '../../src/agents/llm-openai-responses-gateway.js';
import type { LlmCompleteOptions, ToolDefinition } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const CANDIDATE: Candidate = { provider: 'openai', account: null, model: 'gpt-5.6' };
const MSG: AgentMessage = { id: 'm1', session_id: 's1', role: 'user', kind: 'text', content: 'hi', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00.000Z' };
const TOOL: ToolDefinition = { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };

describe('OpenAI Responses request shape', () => {
  it('sends stateless responses fields and non-strict flat tools', () => {
    const opts: LlmCompleteOptions = { inputId: 'input-1', phase: 'tools', contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [TOOL], tool_choice: { kind: 'required_named', toolName: 'read_file' }, max_tokens: 1234 };
    const body = buildOpenAIResponsesRequest(CANDIDATE, 'sys', { sessionId: 's1', messages: [MSG] }, opts, { responsesReasoning: { effort: 'medium' } }) as unknown as Record<string, unknown>;

    expect(body.model).toBe('gpt-5.6');
    expect(body.instructions).toBe('sys');
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.max_output_tokens).toBe(1234);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'read_file' });
    expect(body.tools).toEqual([{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]);
    expect(JSON.stringify(body)).not.toContain('strict');
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });
});
