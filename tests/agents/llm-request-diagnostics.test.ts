import { describe, expect, it } from '@jest/globals';
import type { AgentMessage } from '../../src/schemas/index.js';
import type { LlmCompleteOptions, ToolDefinition } from '../../src/agents/llm-contracts.js';
import {
  appendLlmRequestSectionSizesDiagnostic,
  measureLlmRequestSectionSizes,
} from '../../src/agents/llm-request-diagnostics.js';

function message(partial: Partial<AgentMessage> & { content: string }): AgentMessage {
  return {
    id: partial.id ?? 'msg-1',
    session_id: 'planner:project',
    role: partial.role ?? 'user',
    kind: partial.kind ?? 'text',
    content: partial.content,
    tool: partial.tool,
    round_id: 'round-1',
    message_index: 0,
    block_index: 0,
    timestamp: '2026-06-01T00:00:00.000Z',
  };
}

const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'emit_result',
    description: 'Report terminal completion.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
    },
  },
};

const opts: LlmCompleteOptions = {
  inputId: 'test:input:1',
  phase: 'tools',
  tools: [tool],
  tool_choice: { kind: 'auto' },
  temperature: 0,
  max_tokens: 1234,
  stream: false,
  contract_id: 'planner.v1',
  contractName: 'planner',
  terminalToolOffered: ['emit_result'],
};

describe('LLM request section diagnostics', () => {
  it('identifies largest outbound request section without including raw content', () => {
    const sizes = measureLlmRequestSectionSizes(
      'small system prompt',
      [
        message({ id: 'small', content: 'short' }),
        message({ id: 'large', role: 'assistant', kind: 'context_compaction', content: 'x'.repeat(9000) }),
      ],
      opts,
    );

    expect(sizes.message_count).toBe(2);
    expect(sizes.likely_largest_section).toBe('messages');
    expect(sizes.largest_message).toMatchObject({
      index: 1,
      role: 'assistant',
      kind: 'context_compaction',
      chars: 9000,
    });
  });

  it('formats a compact diagnostic suitable for token-budget blocker persistence', () => {
    const diagnostic = appendLlmRequestSectionSizesDiagnostic(
      'LLM token budget exceeded (HTTP 400)',
      'system ' + 's'.repeat(200),
      [message({ content: 'message ' + 'm'.repeat(400) })],
      opts,
    );

    expect(diagnostic).toContain('request_section_sizes');
    expect(diagnostic).toContain('system_prompt_chars=207');
    expect(diagnostic).toContain('message_count=1');
    expect(diagnostic).toContain('tool_count=1');
    expect(diagnostic).toContain('max_tokens=1234');
    expect(diagnostic).toContain('likely_largest_section=completion_budget');
    expect(diagnostic).not.toContain('system sssss');
    expect(diagnostic).not.toContain('message mmmmm');
  });
});
