import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { LlmPipelineTestClient } from '../helpers/llm-pipeline-test-client.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';

const CANDIDATE: Candidate = { provider: 'openai-chat', account: null, model: 'gpt-5' };
const ADAPTER = selectLlmProtocolAdapter('openai-chat-completions');
const CAPABILITIES = { transportProtocol: 'openai-chat-completions' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, quirks: [] };
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

afterEach(() => { jest.restoreAllMocks(); });

describe('OpenAI Chat adapter request shape', () => {
  it.each<[string, Candidate, string, string, boolean]>([
    ['canonical Copilot URL', { provider: 'github-copilot', account: null, model: 'gpt-5' }, 'https://api.individual.githubcopilot.com', 'https://api.individual.githubcopilot.com/chat/completions', true],
    ['custom Copilot URL', { provider: 'github-copilot', account: null, model: 'gpt-5' }, 'https://proxy.example.test/copilot', 'https://proxy.example.test/copilot/chat/completions', true],
    ['generic Copilot-lookalike URL', CANDIDATE, 'https://api.githubcopilot.com', 'https://api.githubcopilot.com/v1/chat/completions', false],
    ['generic v1 URL', CANDIDATE, 'https://provider.example.test/v1', 'https://provider.example.test/v1/chat/completions', false],
  ])('derives %s from provider identity', (_name, candidate, baseUrl, endpoint, copilotHeaders) => {
    const wire = ADAPTER.deriveWire(candidate, { baseUrl, apiKey: 'resolved-credential' }, {}, options());

    expect(wire.endpoint).toBe(endpoint);
    expect(wire.headers.Authorization).toBe('Bearer resolved-credential');
    expect(wire.headers['User-Agent'] === 'GitHubCopilotChat/0.35.0').toBe(copilotHeaders);
    expect(wire.headers['Editor-Version'] === 'vscode/1.107.0').toBe(copilotHeaders);
    expect(wire.headers['Editor-Plugin-Version'] === 'copilot-chat/0.35.0').toBe(copilotHeaders);
    expect(wire.headers['Copilot-Integration-Id'] === 'vscode-chat').toBe(copilotHeaders);
  });

  it('keeps Chat non-OK context classification without request-section diagnostics', () => {
    const bodyText = JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'messages', message: 'too large' } });
    const error = ADAPTER.classifyHttpFailure(CANDIDATE, new Response(bodyText, { status: 400 }), bodyText, {}, options());

    expect(error).toBeInstanceOf(LlmRequestError);
    expect(error.failure).toMatchObject({
      kind: 'input_context_exhausted',
      provider: 'openai-chat',
      status: 400,
      message: `LLM request failed (HTTP 400): ${bodyText}`,
    });
    expect(error.failure.message).not.toContain('request_section_sizes');
  });

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
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1234);
    expect(body.stream).toBe(false);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'glob',
          description: 'find files',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: 'emit_result',
          description: 'planner terminal envelope',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ]);
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

  it('records current request parameters without an LLM phase while retaining terminal evidence', async () => {
    let sentBody: Record<string, unknown> | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { status: 200 });
    });
    const completion = await new LlmPipelineTestClient({ baseUrl: 'https://example.test', apiKey: 'key' }).complete(CANDIDATE, SYSTEM, { sourceSessionId: 'agent:analyst:global', messages: MESSAGES }, {
      inputId: 'test:input:record', temperature: 0.4, max_tokens: 3456, contract_id: 'test.v1', contractName: 'planner', terminalToolOffered: ['emit_result'], tools: [SAMPLE_TOOL, PLANNER_TERMINAL_TOOL], tool_choice: 'auto',
    });

    expect(sentBody?.stream).toBe(false);
    expect(completion.result).toMatchObject({ kind: 'tool_calls' });
    expect(completion.provider_exchanges[0]).toMatchObject({ request_params: { stream: false, offered_tools_count: 2, method: 'POST', temperature: 0.4, max_tokens: 3456 }, terminal_tool_fired: 'emit_result' });
    expect(completion.provider_exchanges[0]!.request_params).not.toHaveProperty('phase');
  });
});

function options(): LlmCompleteOptions {
  return {
    inputId: 'test:input:wire',
    temperature: 0,
    max_tokens: 100,
    contract_id: 'test.v1',
    contractName: 'test',
    terminalToolOffered: [],
    tools: [],
    tool_choice: 'auto',
  };
}
