import { describe, expect, it } from '@jest/globals';

import { buildOpenAICodexRequest } from '../../src/agents/llm-openai-codex-gateway.js';
import type {
  LlmCompleteOptions,
  ToolDefinition,
} from '../../src/agents/llm-contracts.js';
import type { Candidate } from '../../src/agents/provider.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const CANDIDATE: Candidate = { provider: 'openai-codex', account: null, model: 'gpt-5' };
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
    name: 'list_project_files',
    description: 'list files',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

describe('buildOpenAICodexRequest wire shape', () => {
  it('terminal phase: flat tool shape, string tool_choice, parallel_tool_calls:false, no response_format', () => {
    const opts: LlmCompleteOptions = {
      phase: 'terminal',
      terminalToolName: 'emit_planner_result',
      terminalToolDefinition: PLANNER_TERMINAL_TOOL,
    };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, MESSAGES, opts);

    expect(JSON.stringify(body)).not.toContain('response_format');
    expect(Object.prototype.hasOwnProperty.call(body, 'response_format')).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    // Codex Responses API uses a bare string tool_choice for required-named
    // selection (NOT the nested-function shape used by Chat Completions).
    expect(body.tool_choice).toBe('emit_planner_result');
    // Flat tool entry: no nested `function` wrapper.
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'emit_planner_result',
        description: 'planner terminal envelope',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]);
    expect(JSON.stringify(body.tools)).not.toContain('"function":{');
  });

  it("tools phase with tool_choice 'auto': tool_choice serialized as the string 'auto'", () => {
    const opts: LlmCompleteOptions = {
      phase: 'tools',
      tools: [SAMPLE_TOOL],
      tool_choice: { kind: 'auto' },
    };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, MESSAGES, opts);

    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });

  it('no-tools (analyst message mode): omits tools, tool_choice, parallel_tool_calls', () => {
    const opts: LlmCompleteOptions = {
      phase: 'tools',
      tools: [],
      tool_choice: { kind: 'auto' },
    };
    const body = buildOpenAICodexRequest(CANDIDATE, SYSTEM, MESSAGES, opts);

    expect(Object.prototype.hasOwnProperty.call(body, 'tools')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')).toBe(false);
    expect(JSON.stringify(body)).not.toContain('response_format');
  });
});
