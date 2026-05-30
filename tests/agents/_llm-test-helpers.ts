import type { LlmCompleteOptions, LlmCompleteResult, ToolCall, ToolDefinition } from '../../src/agents/llm-contracts.js';

export function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test.v1', ...(extra as object) } as LlmCompleteOptions;
}

export function messageResult(content: string): LlmCompleteResult {
  return { kind: 'message', content };
}

export function envelopeToolCall(toolName: string, payload: unknown, callId = 'call-1'): ToolCall {
  return {
    id: callId,
    type: 'function',
    function: { name: toolName, arguments: typeof payload === 'string' ? payload : JSON.stringify(payload) },
  };
}

export function toolCallsResult(calls: ToolCall[]): LlmCompleteResult {
  return { kind: 'tool_calls', tool_calls: calls };
}

export function plannerResult(payload: { status?: 'continue' | 'done'; summary?: string; created_cards?: unknown[]; updated_cards?: unknown[] } = {}): LlmCompleteResult {
  const obj = { status: 'done', summary: 'done', created_cards: [], updated_cards: [], ...payload };
  return toolCallsResult([envelopeToolCall('emit_planner_result', obj)]);
}

export function executorResult(payload: unknown): LlmCompleteResult {
  return toolCallsResult([envelopeToolCall('emit_executor_result', payload)]);
}

export function reviewerResult(payload: unknown): LlmCompleteResult {
  return toolCallsResult([envelopeToolCall('emit_reviewer_result', payload)]);
}

export function asMessage(r: LlmCompleteResult): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

export function singleToolDef(name = 'fake_tool'): ToolDefinition {
  return { type: 'function', function: { name, description: 'test', parameters: {} } };
}
