import type { AgentConversationEntry } from '../../api/types';
import { DURABLE_PRIMARY_CONTENT_POLICY } from '../../api/contracts';
import { callEnvelope } from './_helpers';
export function entry(id: string, kind: AgentConversationEntry['kind'], content: string, overrides: Partial<AgentConversationEntry> = {}): AgentConversationEntry {
  return { id, session_id: 'agent:analyst:global', role: kind === 'tool_result' ? 'tool' : 'assistant', kind, content, context_policy: DURABLE_PRIMARY_CONTENT_POLICY, round_id: 'r-assistant-0000000000000000000000000000000a', message_index: 0, block_index: 0, timestamp: '2026-10-07T00:00:00Z', ...overrides };
}
export function call(name: string, args: Record<string, unknown> = {}, id = 'call'): AgentConversationEntry {
  return entry(id, 'tool_call', callEnvelope(name, args, `${name}:${id}`), { tool: name, tool_call_id: `${name}:${id}`, context_policy: { kind: 'tool_call', template: { storage: 'durable', replacement: { kind: 'retain' }, settledAudience: 'primary_and_summarizer', evidenceMode: 'none' }, template_bytes: '{}', template_sha256: '0'.repeat(64) } });
}
export function result(name: string, data: unknown, overrides: Partial<AgentConversationEntry> = {}): AgentConversationEntry {
  return entry('result', 'tool_result', JSON.stringify({ success: true, data }), { tool: name, tool_call_id: `${name}:call`, context_policy: { kind: 'tool_result', settlement_origin: 'executed', result_content_sha256: '0'.repeat(64), call_policy_sha256: '0'.repeat(64), evidence: { kind: 'none' } }, ...overrides });
}
export const processData = { process_id: 'proc-0123456789ab', exit_code: 0, status: 'exited', stdout: 'first\nsecond', stderr: 'warning', stdout_complete: true, stderr_complete: false, stdout_url: 'work:///processes/proc-0123456789ab/stdout.log', stderr_url: 'work:///processes/proc-0123456789ab/stderr.log', stdout_bytes: 12, stderr_bytes: 100 };
export const collection = (items: unknown[], total = items.length) => ({ total, position: { item_index: 0, item_byte_offset: 0 }, returned: items.length, next: null, items });
export const slice = (content: string, offset = 0) => ({ content, utf8_bytes: new TextEncoder().encode(content).length, offset_bytes: offset, next_offset_bytes: offset + new TextEncoder().encode(content).length });
