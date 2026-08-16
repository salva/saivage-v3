import { describe, expect, it } from '@jest/globals';
import type { LlmCompleteOptions, ToolDefinition } from '../../src/agents/llm-contracts.js';
import {
  appendFinalOutboundLlmRequestSectionSizesDiagnostic,
  measureFinalOutboundLlmRequestSectionSizes,
  type LlmRequestDiagnosticMessage,
} from '../../src/agents/llm-request-diagnostics.js';

function message(partial: Partial<LlmRequestDiagnosticMessage> & { content: string }): LlmRequestDiagnosticMessage {
  return {
    role: partial.role ?? 'user',
    kind: partial.kind ?? 'text',
    content: partial.content,
    tool: partial.tool,
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
  tools: [tool],
  tool_choice: 'auto',
  temperature: 0,
  max_tokens: 1234,
  contract_id: 'planner.v1',
  contractName: 'planner',
  terminalToolOffered: ['emit_result'],
};

describe('LLM request section diagnostics', () => {
  it('identifies largest outbound request section without including raw content', () => {
    const sizes = measureFinalOutboundLlmRequestSectionSizes(
      'small system prompt',
      [
        message({ content: 'short' }),
        message({ role: 'assistant', kind: 'text', content: 'x'.repeat(9000) }),
      ],
      opts.tools.length,
      JSON.stringify(opts.tools).length,
      opts,
    );

    expect(sizes.message_count).toBe(2);
    expect(sizes.likely_largest_section).toBe('messages');
    expect(sizes.largest_message).toMatchObject({
      index: 1,
      role: 'assistant',
      kind: 'text',
      chars: 9000,
    });
  });

  it('formats a compact diagnostic suitable for token-budget blocker persistence', () => {
    const diagnostic = appendFinalOutboundLlmRequestSectionSizesDiagnostic(
      'LLM token budget exceeded (HTTP 400)',
      'system ' + 's'.repeat(200),
      [message({ content: 'message ' + 'm'.repeat(400) })],
      opts.tools.length,
      JSON.stringify(opts.tools).length,
      opts,
    );

    expect(diagnostic).toContain('request_section_sizes');
    expect(diagnostic).toContain('system_prompt_chars=207');
    expect(diagnostic).toContain('message_count=1');
    expect(diagnostic).toContain('tool_count=1');
    expect(diagnostic).toContain('max_tokens=1234');
    expect(diagnostic).not.toContain('phase=');
    expect(diagnostic).toContain('likely_largest_section=completion_budget');
    expect(diagnostic).not.toContain('system sssss');
    expect(diagnostic).not.toContain('message mmmmm');
  });
});
