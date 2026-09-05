import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { LlmPipelineTestClient } from '../helpers/llm-pipeline-test-client.js';
import { makeCodexJwt } from '../helpers/llm-test-helpers.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';

afterEach(() => { jest.restoreAllMocks(); });

const CANDIDATE: Candidate = { provider: 'openai-codex', account: null, model: 'gpt-5' };
const ADAPTER = selectLlmProtocolAdapter('openai-codex-backend');
const CAPABILITIES = { transportProtocol: 'openai-codex-backend' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'parallel_off' as const, quirks: ['openai-codex-backend'] };
const SYSTEM = 'system-prompt';
const MESSAGES: AgentMessage[] = [
  {
    id: 'm1',
    session_id: 'agent:analyst:global',
    role: 'user',
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } },
    kind: 'text',
    content: 'hi',
    round_id: 'r1',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
  },
];

const PLANNER_TERMINAL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'emit_result',
    description: 'planner terminal envelope',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const SAMPLE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'find files',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

describe('OpenAI Codex adapter request shape', () => {
  it('preserves the ordered operational and terminal tool surface with auto choice and parallel calls disabled', () => {
    const opts: LlmCompleteOptions = {
      inputId: 'test:input:1',
      temperature: 0.2,
      max_tokens: 1234,
      contract_id: 'test.v1',
      contractName: 'planner',
      terminalToolOffered: ['emit_result'],
      tools: [SAMPLE_TOOL, PLANNER_TERMINAL_TOOL],
      tool_choice: 'auto',
    };
    const body = ADAPTER.buildRequestBody({ candidate: CANDIDATE, systemPrompt: SYSTEM, providerConversation: { sourceSessionId: 'agent:analyst:global', messages: MESSAGES }, options: opts, capabilities: CAPABILITIES });

    expect(JSON.stringify(body)).not.toContain('response_format');
    expect(Object.prototype.hasOwnProperty.call(body, 'response_format')).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'glob',
        description: 'find files',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        type: 'function',
        name: 'emit_result',
        description: 'planner terminal envelope',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]);
    expect(JSON.stringify(body.tools)).not.toContain('"function":{');
    expect(Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'temperature')).toBe(false);
  });

  it('omits the configured completion quantity and universally projects system context into instructions', () => {
    const opts: LlmCompleteOptions = { inputId: 'test:input:1', temperature: 0.2, contract_id: 'test.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: 'auto', max_tokens: 777 };
    const body = ADAPTER.buildRequestBody({ candidate: CANDIDATE, systemPrompt: SYSTEM, providerConversation: { sourceSessionId: 'agent:analyst:global', messages: [{ ...MESSAGES[0]!, id: 'system-row', role: 'system', content: 'compacted context' }] }, options: opts, capabilities: CAPABILITIES });
    expect(Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')).toBe(false);
    expect(body.instructions).toContain('compacted context');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'Proceed with the task described in the instructions.' }] }]);
  });

  it('no-tools (analyst message mode): omits tools, tool_choice, parallel_tool_calls', () => {
    const opts: LlmCompleteOptions = {
      inputId: 'test:input:1',
      temperature: 0.3,
      max_tokens: 2345,
      contract_id: 'test.v1',
      contractName: 'analyst',
      terminalToolOffered: [],
      tools: [],
      tool_choice: 'auto',
    };
    const body = ADAPTER.buildRequestBody({ candidate: CANDIDATE, systemPrompt: SYSTEM, providerConversation: { sourceSessionId: 'agent:analyst:global', messages: MESSAGES }, options: opts, capabilities: CAPABILITIES });

    expect(Object.prototype.hasOwnProperty.call(body, 'tools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });
});

describe('OpenAI Codex adapter and runner context failure evidence', () => {
  const opts = (): LlmCompleteOptions => ({
    inputId: 'test:input:context',
    temperature: 0.4,
    max_tokens: 3456,
    contract_id: 'test.v1',
    contractName: 'planner',
    terminalToolOffered: [],
    tools: [],
    tool_choice: 'auto',
  });

  it('keeps non-OK HTTP classification and source evidence owned by Codex', () => {
    const bodyText = JSON.stringify({ error: { code: 'content_filter', message: 'blocked by policy' } });
    const error = ADAPTER.classifyHttpFailure(CANDIDATE, new Response(bodyText, { status: 403 }), bodyText, {}, opts());

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error.failure).toMatchObject({
      kind: 'content_policy',
      provider: 'openai-codex',
      status: 403,
      message: `LLM request failed (HTTP 403): ${bodyText}`,
      providerResponse: bodyText,
    });
  });

  it('records the actual opened HTTP 200 status for a typed Codex SSE context failure', async () => {
    const event = { type: 'error', error: { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input' } };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const options = opts();
    const gateway = new LlmPipelineTestClient({ baseUrl: 'https://example.test', apiKey: makeCodexJwt('account') });

    let failure: unknown;
    try { await gateway.complete(CANDIDATE, SYSTEM, { sourceSessionId: 'agent:analyst:global', messages: MESSAGES }, options); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({
        originalFailure: { failure: { kind: 'input_context_exhausted', status: 200 } },
        provider_exchanges: [{ status: 'error', response_status: 200, request_params: { endpoint: 'https://example.test/codex/responses', method: 'POST', stream: true, offered_tools_count: 0 }, error: { status: 200 } }],
      });
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect((failure as ProviderTurnFailure).provider_exchanges[0]!.request_params).toEqual({ endpoint: 'https://example.test/codex/responses', method: 'POST', stream: true, offered_tools_count: 0 });
  });

  it('records HTTP 400 for the same typed evidence returned before an SSE stream opens', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'context_length_exceeded', param: 'input' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    const options = opts();
    const gateway = new LlmPipelineTestClient({ baseUrl: 'https://example.test', apiKey: makeCodexJwt('account') });

    await expect(gateway.complete(CANDIDATE, SYSTEM, { sourceSessionId: 'agent:analyst:global', messages: MESSAGES }, options))
      .rejects.toMatchObject({
        originalFailure: { failure: { kind: 'input_context_exhausted', status: 400 } },
        provider_exchanges: [{ status: 'error', response_status: 400, error: { status: 400 } }],
      });
  });
});
