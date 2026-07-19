import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildOpenAICodexRequest, OpenAICodexGateway } from '../../src/agents/llm-openai-codex-gateway.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { createProviderExchangeRecorder } from '../../src/agents/provider-exchange-recorder.js';

afterEach(() => { jest.restoreAllMocks(); });

const CANDIDATE: Candidate = { provider: 'openai-codex', account: null, model: 'gpt-5' };
const SYSTEM = 'system-prompt';
const MESSAGES: AgentMessage[] = [
  {
    id: 'm1',
    session_id: 'analyst:global',
    role: 'user',
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

describe('buildOpenAICodexRequest wire shape', () => {
  it('preserves the ordered operational and terminal tool surface with auto choice and parallel calls disabled', () => {
    const opts: LlmCompleteOptions = {
      inputId: 'test:input:1',
      contract_id: 'test.v1',
      contractName: 'planner',
      terminalToolOffered: ['emit_result'],
      tools: [SAMPLE_TOOL, PLANNER_TERMINAL_TOOL],
      tool_choice: 'auto',
    };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, opts);

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
  });

  it('omits the configured completion quantity and universally projects system context into instructions', () => {
    const opts: LlmCompleteOptions = { inputId: 'test:input:1', contract_id: 'test.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: 'auto', max_tokens: 777 };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: [{ ...MESSAGES[0]!, id: 'system-row', role: 'system', content: 'compacted context' }] }, opts);
    expect(Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')).toBe(false);
    expect(body.instructions).toContain('compacted context');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'Proceed with the task described in the instructions.' }] }]);
  });

  it('no-tools (analyst message mode): omits tools, tool_choice, parallel_tool_calls', () => {
    const opts: LlmCompleteOptions = {
      inputId: 'test:input:1',
      contract_id: 'test.v1',
      contractName: 'analyst',
      terminalToolOffered: [],
      tools: [],
      tool_choice: 'auto',
    };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, opts);

    expect(Object.prototype.hasOwnProperty.call(body, 'tools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });
});

describe('OpenAICodexGateway context failure evidence', () => {
  const opts = (): LlmCompleteOptions => ({
    inputId: 'test:input:context',
    contract_id: 'test.v1',
    contractName: 'planner',
    terminalToolOffered: [],
    tools: [],
    tool_choice: 'auto',
    recorder: createProviderExchangeRecorder({ sessionId: 'analyst:global' }),
  });

  it('records the actual opened HTTP 200 status for a typed Codex SSE context failure', async () => {
    const event = { type: 'error', error: { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input' } };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const options = opts();
    const gateway = new OpenAICodexGateway({ baseUrl: 'https://example.test', apiKey: 'test-key', openAICodexAccountId: 'account' });

    await expect(gateway.complete(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, 'analyst:global', options))
      .rejects.toMatchObject({
        failure: { kind: 'input_context_exhausted', status: 200 },
        provider_exchanges: [{ status: 'error', response_status: 200, error: { status: 200 } }],
      });
    expect(options.recorder!.settledAttempts()[0]!.request_params).not.toHaveProperty('phase');
  });

  it('records HTTP 400 for the same typed evidence returned before an SSE stream opens', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'context_length_exceeded', param: 'input' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    const options = opts();
    const gateway = new OpenAICodexGateway({ baseUrl: 'https://example.test', apiKey: 'test-key', openAICodexAccountId: 'account' });

    await expect(gateway.complete(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, 'analyst:global', options))
      .rejects.toMatchObject({
        failure: { kind: 'input_context_exhausted', status: 400 },
        provider_exchanges: [{ status: 'error', response_status: 400, error: { status: 400 } }],
      });
  });
});
