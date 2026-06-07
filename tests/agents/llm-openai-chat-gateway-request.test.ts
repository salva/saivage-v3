import { describe, expect, it } from '@jest/globals';

import { buildOpenAIChatRequest } from '../../src/agents/llm-openai-chat-gateway.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/agents/provider.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const CANDIDATE: Candidate = { provider: 'openai-chat', account: null, model: 'gpt-5' };
const SYSTEM = 'system-prompt';
const MESSAGES: AgentMessage[] = [
  {
    id: 'm1',
    session_id: 's1',
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
    name: 'emit_planner_result',
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

describe('buildOpenAIChatRequest wire shape', () => {
  it('terminal phase: nested tool_choice, parallel tool calls allowed, no response_format', () => {
    const opts: LlmCompleteOptions = {
      phase: 'terminal',
      contract_id: 'test.v1',
      contractName: 'planner',
      terminalToolOffered: ['emit_planner_result'],
      terminalToolName: 'emit_planner_result',
      terminalToolDefinition: PLANNER_TERMINAL_TOOL,
    };
    const body = buildOpenAIChatRequest(CANDIDATE, SYSTEM, MESSAGES, opts) as unknown as Record<string, unknown>;

    expect(JSON.stringify(body)).not.toContain('response_format');
    expect(Object.prototype.hasOwnProperty.call(body, 'response_format')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_planner_result' },
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'emit_planner_result',
          description: 'planner terminal envelope',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ]);
  });

  it("tools phase with tool_choice 'auto': tool_choice serialized as the string 'auto'", () => {
    const opts: LlmCompleteOptions = {
      phase: 'tools',
      contract_id: 'test.v1',
      contractName: 'planner',
      terminalToolOffered: [],
      tools: [SAMPLE_TOOL],
      tool_choice: { kind: 'auto' },
    };
    const body = buildOpenAIChatRequest(CANDIDATE, SYSTEM, MESSAGES, opts) as unknown as Record<string, unknown>;

    expect(body.tool_choice).toBe('auto');
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });

  it('no-tools (analyst message mode): omits tools, tool_choice, parallel_tool_calls', () => {
    const opts: LlmCompleteOptions = {
      phase: 'tools',
      contract_id: 'test.v1',
      contractName: 'analyst',
      terminalToolOffered: [],
      tools: [],
      tool_choice: { kind: 'auto' },
    };
    const body = buildOpenAIChatRequest(CANDIDATE, SYSTEM, MESSAGES, opts) as unknown as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(body, 'tools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });
});
