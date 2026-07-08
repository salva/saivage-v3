import type { AgentMessage } from '../../../schemas/index.js';

export type RecoverableEvidenceDescriptor =
  | { flavor: 'stash'; url: string; label: string; bytes?: number }
  | { flavor: 'process_stdout' | 'process_stderr'; url: string; label: string; bytes?: number }
  | { flavor: 'source_recallable'; tool: string; args: unknown; label: string };

const SOURCE_RECALLABLE_TOOLS = new Set(['read', 'glob', 'grep', 'get_card', 'list_cards', 'list_files', 'list_processes', 'list_agents']);

export function dropRecoverableResultBodies(messages: AgentMessage[]): AgentMessage[] {
  const calls = toolCallsById(messages);
  return messages.map((message) => {
    if (message.kind !== 'tool_result') return cloneMessage(message);
    const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
    const tool = message.tool ?? call?.tool;
    const content = parseJsonObject(message.content);
    const data = objectValue(content.data);

    if (tool && isSourceRecallableTool(tool) && call) {
      return withContent(message, { success: content.success, recovered_from: { tool, args: toolCallArgs(call) }, note: 'compacted; re-run source-recallable tool to recover full result' });
    }
    if (typeof data.stash_url === 'string') {
      return withContent(message, { success: content.success, recovered_from: data.stash_url, bytes: numberValue(data.bytes), note: 'compacted to stash; use read to recover full content' });
    }
    if (typeof data.stdout_url === 'string' || typeof data.stderr_url === 'string') {
      const compacted: Record<string, unknown> = { success: content.success, note: 'compacted process output; use read to recover full content' };
      for (const [key, value] of Object.entries(data)) {
        compacted[key] = value;
      }
      return withContent(message, { success: content.success, data: compacted });
    }
    return cloneMessage(message);
  });
}

export function recoverableEvidenceDescriptors(messages: AgentMessage[]): RecoverableEvidenceDescriptor[] {
  const calls = toolCallsById(messages);
  const descriptors: RecoverableEvidenceDescriptor[] = [];
  for (const message of messages) {
    if (message.kind !== 'tool_result') continue;
    const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
    const tool = message.tool ?? call?.tool;
    const content = parseJsonObject(message.content);
    const data = objectValue(content.data);
    if (tool && isSourceRecallableTool(tool) && call) {
      const args = toolCallArgs(call);
      descriptors.push({ flavor: 'source_recallable', tool, args, label: sourceLabel(args) });
    }
    if (typeof data.stash_url === 'string') {
      descriptors.push({ flavor: 'stash', url: data.stash_url, label: webfetchLabel(call), bytes: numberValue(data.bytes) });
    }
    if (typeof data.stdout_url === 'string') {
      descriptors.push({ flavor: 'process_stdout', url: data.stdout_url, label: processLabel(call), bytes: numberValue(data.stdout_bytes) });
    }
    if (typeof data.stderr_url === 'string') {
      descriptors.push({ flavor: 'process_stderr', url: data.stderr_url, label: processLabel(call), bytes: numberValue(data.stderr_bytes) });
    }
  }
  return descriptors;
}

function toolCallsById(messages: AgentMessage[]): Map<string, AgentMessage> {
  const calls = new Map<string, AgentMessage>();
  for (const message of messages) if (message.kind === 'tool_call' && message.tool_call_id) calls.set(message.tool_call_id, message);
  return calls;
}

function isSourceRecallableTool(tool: string): boolean {
  return SOURCE_RECALLABLE_TOOLS.has(tool) || tool.startsWith('list_');
}

function toolCallArgs(message: AgentMessage): unknown {
  const content = parseJsonObject(message.content);
  const toolCalls = Array.isArray(content.tool_calls) ? content.tool_calls : [];
  const first = objectValue(toolCalls[0]);
  const fn = objectValue(first.function);
  if (typeof fn.arguments !== 'string') return {};
  try { return JSON.parse(fn.arguments) as unknown; } catch { throw new Error(`Tool call '${message.id}' has malformed JSON arguments.`); }
}

function sourceLabel(args: unknown): string {
  if (typeof args !== 'object' || args === null) return 'source recallable tool result';
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'pattern', 'card_id', 'query']) if (typeof record[key] === 'string') return record[key];
  return 'source recallable tool result';
}

function webfetchLabel(call: AgentMessage | undefined): string {
  const args = call ? toolCallArgs(call) : undefined;
  if (typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>).url === 'string') return `webfetch of ${(args as Record<string, unknown>).url}`;
  return 'webfetch stashed result';
}

function processLabel(call: AgentMessage | undefined): string {
  const args = call ? toolCallArgs(call) : undefined;
  if (typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>).command === 'string') return (args as Record<string, unknown>).command as string;
  return 'process output';
}

function withContent(message: AgentMessage, content: unknown): AgentMessage {
  return { ...message, content: JSON.stringify(content) };
}

function cloneMessage(message: AgentMessage): AgentMessage {
  return { ...message };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Recoverable tool result content must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
