import { describe, expect, it } from '@jest/globals';
import type { AgentMessage, MessageKind, MessageRole } from '../../../src/schemas/index.js';
import { classifyConversation } from '../../../src/runtime/actors/conversation-recovery.js';

const terminalTools = new Set(['emit_result']);

function message(overrides: Partial<AgentMessage> & { kind: MessageKind; id?: string; role?: MessageRole }): AgentMessage {
  return {
    id: overrides.id ?? `${overrides.kind}-1`,
    session_id: overrides.session_id ?? 'planner:G-1',
    role: overrides.role ?? 'system',
    kind: overrides.kind,
    content: overrides.content ?? '',
    round_id: overrides.round_id ?? 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    message_index: overrides.message_index ?? 0,
    block_index: overrides.block_index ?? 0,
    timestamp: overrides.timestamp ?? '2026-07-08T00:00:00.000Z',
    tool: overrides.tool,
    tool_call_id: overrides.tool_call_id,
  };
}

function toolCall(sourceInputId: string, toolCallId: string, sessionId = 'planner:G-1', tool = 'emit_result'): AgentMessage {
  return message({
    id: `${sourceInputId}:tool-call:${toolCallId}`,
    session_id: sessionId,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: tool, arguments: '{}' } }] }),
  });
}

function toolResult(sourceInputId: string, toolCallId: string, sessionId = 'planner:G-1', tool = 'emit_result'): AgentMessage {
  return message({
    id: `${sourceInputId}:tool:0:tool-result:${toolCallId}`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_result',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify({ success: true }),
  });
}

function toolError(sourceInputId: string, toolCallId: string, sessionId = 'planner:G-1', tool = 'emit_result'): AgentMessage {
  return message({
    id: `${sourceInputId}:tool-error:${toolCallId}`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_error',
    tool,
    tool_call_id: toolCallId,
    content: 'tool failed',
  });
}

describe('classifyConversation', () => {
  it('returns the six implicit states', () => {
    expect(classifyConversation([], terminalTools)).toBe('empty');
    expect(classifyConversation([message({ kind: 'system_prompt', role: 'system' })], terminalTools)).toBe('system_prompt_only');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:1', 'call-1')], terminalTools)).toBe('settled_terminal');
    expect(classifyConversation([message({ kind: 'text', role: 'assistant', content: 'plain text' })], terminalTools)).toBe('assistant_text_pending');
    expect(classifyConversation([message({ kind: 'model_repair', role: 'user', content: 'repair' })], terminalTools)).toBe('pending_provider');
  });

  it('defines dispositions for every message kind', () => {
    expect(classifyConversation([message({ kind: 'activity' })], terminalTools)).toBe('empty');
    expect(classifyConversation([message({ kind: 'provider_exchange' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_issue' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_repair' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'context_compaction' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_recovered' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'text', role: 'user' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:1', 'call-1')], terminalTools)).toBe('settled_terminal');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolError('planner:G-1:1', 'call-1')], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'system_prompt' }), message({ kind: 'activity' })], terminalTools)).toBe('system_prompt_only');
  });

  it('matches tool settlements by full session, source input, and tool call id', () => {
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolCall('planner:G-1:2', 'call-dup'),
      toolError('planner:G-1:2', 'call-dup'),
    ], terminalTools)).toBe('pending_provider');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolError('planner:G-1:2', 'call-dup'),
    ], terminalTools)).toBe('awaiting_tool_result');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1', 'planner:G-1'),
      toolError('planner:G-1:1', 'call-1', 'reviewer:G-1'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('does not classify tool_error-only terminal settlement as model-visible settled_terminal', () => {
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolError('planner:G-1:1', 'call-1')], terminalTools)).toBe('pending_provider');
  });

  it('ignores invalid or unmatched tool_error rows for recovery settlement', () => {
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      { ...toolError('planner:G-1:1', 'call-1'), id: 'planner:G-1:1:error:call-1' },
    ], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      { ...toolError('planner:G-1:1', 'call-1'), tool: undefined },
    ], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      toolError('planner:G-1:1', 'call-2'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('requires a terminal-named tool_call plus matching model-visible tool_result for settled_terminal', () => {
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1', 'planner:G-1', 'read_file'), toolResult('planner:G-1:1', 'call-1', 'planner:G-1', 'read_file')], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:2', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
  });
});
