import { describe, expect, it } from '@jest/globals';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type MessageKind, type MessageRole } from '../../../src/schemas/index.js';
import { classifyConversation } from '../../../src/runtime/actors/conversation-recovery.js';
import { hashConversationRows, validateConversationRows } from '../../../src/contracts/conversation-compaction.js';

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

function toolResult(sourceInputId: string, toolCallId: string, sessionId = 'planner:G-1', tool = 'emit_result', result: unknown = { success: true }): AgentMessage {
  return message({
    id: `${sourceInputId}:tool-result:${toolCallId}`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_result',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
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
    expect(classifyConversation([message({ kind: 'model_issue' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_repair' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'context_compaction' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_recovered' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'text', role: 'user' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:1', 'call-1')], terminalTools)).toBe('settled_terminal');
    expect(classifyConversation([message({ kind: 'system_prompt' }), message({ kind: 'activity' })], terminalTools)).toBe('system_prompt_only');
  });

  it('classifies a strictly validated current-format compaction row as pending_provider', () => {
    const source = agentMessageSchema.parse(message({ id: 'activation', kind: 'activity', content: JSON.stringify({ event: 'activation_open' }) }));
    const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: [source.id] }] }], content_hash: hashConversationRows([source]), summary_text: 'summary', evidence: [] }], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' } });
    const metadata = agentMessageSchema.parse(message({ id: 'compaction', kind: 'context_compaction', content: canonicalJson(payload), round_id: 'r-compacted-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    const validated = validateConversationRows([source, metadata]);
    expect(classifyConversation(validated.physicalRows, terminalTools)).toBe('pending_provider');
    expect(() => validateConversationRows([source, { ...metadata, content: canonicalJson({ ...payload, summaries: [{ ...payload.summaries[0]!, content_hash: '0'.repeat(64) }] }) }])).toThrow(/hash mismatch/);
  });

  it('matches tool settlements by full session, source input, and tool call id', () => {
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolCall('planner:G-1:2', 'call-dup', 'planner:G-1', 'read_file'),
      toolResult('planner:G-1:2', 'call-dup', 'planner:G-1', 'read_file'),
    ], terminalTools)).toBe('pending_provider');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolResult('planner:G-1:2', 'call-dup'),
    ], terminalTools)).toBe('awaiting_tool_result');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1', 'planner:G-1'),
      toolResult('planner:G-1:1', 'call-1', 'reviewer:G-1'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('treats a failed tool_result as a settlement without changing its payload', () => {
    const result = toolResult('planner:G-1:1', 'call-1', 'planner:G-1', 'emit_result', { success: false, error: 'tool failed' });
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), result], terminalTools)).toBe('settled_terminal');
    expect(result.content).toBe('{"success":false,"error":"tool failed"}');
  });

  it('fails fast on malformed tool_result rows and does not match valid rows for other triples', () => {
    expect(() => classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      { ...toolResult('planner:G-1:1', 'call-1'), id: 'planner:G-1:1:result:call-1' },
    ], terminalTools)).toThrow(/Malformed tool_result/);
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      toolResult('planner:G-1:1', 'call-2'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('requires a terminal-named tool_call plus matching model-visible tool_result for settled_terminal', () => {
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1', 'planner:G-1', 'read_file'), toolResult('planner:G-1:1', 'call-1', 'planner:G-1', 'read_file')], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:2', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
  });
});
