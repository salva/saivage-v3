import type { AgentMessage } from './types.js';

export interface LoggedToolMessageIdentity {
  session_id: string;
  source_input_id: string;
  tool_call_id: string;
}

export function loggedToolCallKey(record: LoggedToolMessageIdentity): string {
  return [record.session_id, record.source_input_id, record.tool_call_id].join(':');
}

export function sourceInputIdFromToolCallMessageId(id: string, toolCallId?: string): string {
  const suffix = toolCallId ? `:tool-call:${toolCallId}` : ':tool-call:';
  const index = toolCallId ? id.lastIndexOf(suffix) : id.indexOf(suffix);
  if (index <= 0) throw new Error(`Malformed tool_call message id '${id}': missing '${suffix}'.`);
  if (toolCallId && index + suffix.length !== id.length) throw new Error(`Malformed tool_call message id '${id}': unexpected trailing content.`);
  return id.slice(0, index);
}

export function sourceInputIdFromToolResultMessageId(id: string, toolCallId?: string): string {
  const suffix = toolCallId ? `:tool-result:${toolCallId}` : ':tool-result:';
  const suffixIndex = toolCallId ? id.lastIndexOf(suffix) : id.indexOf(suffix);
  if (suffixIndex <= 0) throw new Error(`Malformed tool_result message id '${id}': missing '${suffix}'.`);
  if (toolCallId && suffixIndex + suffix.length !== id.length) throw new Error(`Malformed tool_result message id '${id}': unexpected trailing content.`);
  return id.slice(0, suffixIndex);
}

export function sourceInputIdFromToolErrorMessageId(id: string, toolCallId: string): string {
  if (!toolCallId) throw new Error(`Malformed tool_error message id '${id}': missing tool_call_id.`);
  const suffix = `:tool-error:${toolCallId}`;
  const suffixIndex = id.lastIndexOf(suffix);
  if (suffixIndex <= 0) throw new Error(`Malformed tool_error message id '${id}': missing '${suffix}'.`);
  if (suffixIndex + suffix.length !== id.length) throw new Error(`Malformed tool_error message id '${id}': unexpected trailing content.`);
  return id.slice(0, suffixIndex);
}

export function loggedToolCallIdentity(message: AgentMessage): LoggedToolMessageIdentity | null {
  if (message.kind !== 'tool_call' || !message.tool_call_id) return null;
  return { session_id: message.session_id, source_input_id: sourceInputIdFromToolCallMessageId(message.id, message.tool_call_id), tool_call_id: message.tool_call_id };
}

export function loggedToolResultIdentity(message: AgentMessage): LoggedToolMessageIdentity | null {
  if (message.kind !== 'tool_result' || !message.tool_call_id) return null;
  return { session_id: message.session_id, source_input_id: sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id), tool_call_id: message.tool_call_id };
}

export function loggedToolErrorIdentity(message: AgentMessage): LoggedToolMessageIdentity | null {
  if (message.kind !== 'tool_error' || !message.tool_call_id || !message.tool) return null;
  return { session_id: message.session_id, source_input_id: sourceInputIdFromToolErrorMessageId(message.id, message.tool_call_id), tool_call_id: message.tool_call_id };
}
