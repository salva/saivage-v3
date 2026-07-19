import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { buildOpenAIChatRequest, OpenAIChatGateway } from '../../src/agents/llm-openai-chat-gateway.js';
import { createProviderExchangeRecorder } from '../../src/agents/provider-exchange-recorder.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const CANDIDATE: Candidate = { provider: 'openai-chat', account: null, model: 'gpt-5' };
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

afterEach(() => { jest.restoreAllMocks(); });

describe('buildOpenAIChatRequest wire shape', () => {
  it('preserves the ordered operational and terminal tool surface with auto choice and parallel calls disabled', () => {
    const opts: LlmCompleteOptions = {
      inputId: 'test:input:1',
      contract_id: 'test.v1',
      contractName: 'planner',
      terminalToolOffered: ['emit_result'],
      tools: [SAMPLE_TOOL, PLANNER_TERMINAL_TOOL],
      tool_choice: 'auto',
    };
    const body = buildOpenAIChatRequest(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, opts) as unknown as Record<string, unknown>;

    expect(JSON.stringify(body)).not.toContain('response_format');
    expect(Object.prototype.hasOwnProperty.call(body, 'response_format')).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
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
      contract_id: 'test.v1',
      contractName: 'analyst',
      terminalToolOffered: [],
      tools: [],
      tool_choice: 'auto',
    };
    const body = buildOpenAIChatRequest(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, opts) as unknown as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(body, 'tools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });

  it('records current request parameters without an LLM phase while retaining terminal evidence', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { status: 200 }));
    const recorder = createProviderExchangeRecorder({ sessionId: 'analyst:global' });
    await new OpenAIChatGateway({ baseUrl: 'https://example.test', apiKey: 'key' }).complete(CANDIDATE, SYSTEM, { sourceSessionId: 'analyst:global', messages: MESSAGES }, 'analyst:global', {
      inputId: 'test:input:record', contract_id: 'test.v1', contractName: 'planner', terminalToolOffered: ['emit_result'], tools: [SAMPLE_TOOL, PLANNER_TERMINAL_TOOL], tool_choice: 'auto', recorder,
    });

    expect(recorder.settledAttempts()[0]).toMatchObject({ request_params: { offered_tools_count: 1, method: 'POST' }, terminal_tool_fired: 'emit_result' });
    expect(recorder.settledAttempts()[0]!.request_params).not.toHaveProperty('phase');
  });
});
