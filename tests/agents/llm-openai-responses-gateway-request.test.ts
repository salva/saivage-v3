import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { buildOpenAIResponsesRequest } from '../../src/agents/llm-openai-responses-adapter.js';
import type { LlmCompleteOptions, ToolDefinition } from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { LlmPipelineTestClient } from '../helpers/llm-pipeline-test-client.js';
import { durableContentPolicy } from '../helpers/message-context-policy.js';

const CANDIDATE: Candidate = { provider: 'openai', account: null, model: 'gpt-5.6' };
const MSG: AgentMessage = { id: 'm1', session_id: 'agent:analyst:global', role: 'user', kind: 'text', content: 'hi', context_policy: durableContentPolicy(), round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00.000Z' };
const TOOL: ToolDefinition = { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
const TERMINAL_TOOL: ToolDefinition = { type: 'function', function: { name: 'emit_result', description: 'finish', parameters: { type: 'object', properties: { summary: { type: 'string' } } } } };

afterEach(() => { jest.restoreAllMocks(); });

describe('OpenAI Responses request shape', () => {
  it('sends stateless fields and preserves the ordered operational and terminal tool surface', () => {
    const opts: LlmCompleteOptions = { inputId: 'input-1', temperature: 0.2, contract_id: 'c', contractName: 'contract', terminalToolOffered: ['emit_result'], tools: [TOOL, TERMINAL_TOOL], tool_choice: 'auto', max_tokens: 1234 };
    const body = buildOpenAIResponsesRequest(CANDIDATE, 'sys', [], { sourceSessionId: 'agent:analyst:global', messages: [MSG] }, opts, { responsesReasoning: { effort: 'medium' } }) as unknown as Record<string, unknown>;

    expect(body.model).toBe('gpt-5.6');
    expect(body.instructions).toBe('sys');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.max_output_tokens).toBe(1234);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { type: 'function', name: 'emit_result', description: 'finish', parameters: { type: 'object', properties: { summary: { type: 'string' } } } },
    ]);
    expect(JSON.stringify(body)).not.toContain('strict');
    expect(body.reasoning).toEqual({ effort: 'medium' });
  });

  it('uses only the latest rendered context and never serializes raw compaction metadata or covered history', () => {
    const opts: LlmCompleteOptions = { inputId: 'input-2', temperature: 0.3, max_tokens: 2345, contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [], tool_choice: 'auto' };
    const latest: AgentMessage = { ...MSG, id: 'c2:rendered', role: 'system', content: 'latest C2 rendered context' };
    const suffix: AgentMessage = { ...MSG, id: 'suffix', content: 'uncovered suffix' };
    const body = buildOpenAIResponsesRequest(CANDIDATE, 'role prompt', [], { sourceSessionId: 'agent:analyst:global', messages: [latest, suffix] }, opts) as unknown as { instructions: string; input: unknown[] };

    expect(body.instructions).toBe('role prompt\n\n--- system context ---\nlatest C2 rendered context');
    expect(JSON.stringify(body)).not.toContain('older C1 rendered context');
    expect(JSON.stringify(body)).not.toContain('context_compaction');
    expect(JSON.stringify(body.input)).toContain('uncovered suffix');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('parallel_tool_calls');
  });

  it('uses complete JSON without requesting SSE and records the fixed wire mode', async () => {
    let sentBody: Record<string, unknown> | undefined;
    let sentHeaders: Headers | undefined;
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'done' }] },
    ];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ status: 'completed', output, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new LlmPipelineTestClient({
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'key',
      capabilities: {
        transportProtocol: 'openai-responses',
        toolsMode: 'native',
        exclusiveToolChoiceSupport: 'native',
        quirks: [],
      },
    });
    const completion = await client.complete(
      CANDIDATE,
      'sys',
      { sourceSessionId: 'agent:analyst:global', messages: [MSG] },
      'agent:analyst:global',
      { inputId: 'input-json', temperature: 0.2, contract_id: 'c', contractName: 'contract', terminalToolOffered: [], tools: [], tool_choice: 'auto', max_tokens: 1234 },
    );

    expect(sentBody?.stream).toBe(false);
    expect(sentHeaders?.has('Accept')).toBe(false);
    expect(completion.result).toEqual({ kind: 'message', content: 'done', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    expect(completion.provider_private_context).toEqual({ kind: 'openai_responses', source_input_id: 'input-json', provider: 'openai', model: 'gpt-5.6', output });
    expect(completion.provider_exchanges[0]!.request_params).toMatchObject({ method: 'POST', stream: false, store: false, include: ['reasoning.encrypted_content'] });
  });

});
