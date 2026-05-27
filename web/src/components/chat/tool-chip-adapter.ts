import type { ChatMessage, PendingCall } from '../../api/types';
import { presentToolCall, presentToolResult, type ToolCallPresentation, type ToolResultPresentation } from '../../utils/tool-presenters';

export interface ToolChipPropsBag {
  call: ToolCallPresentation;
  result: ToolResultPresentation | null;
  callContent: string;
  resultContent: string | null;
  status: 'pending' | 'ok' | 'error';
  expanded: boolean;
  detailsId: string;
  timestamp?: string;
}

export function adaptChatMessageToToolChip(message: ChatMessage, expanded: boolean): ToolChipPropsBag {
  if (message.kind === 'tool_call') {
    return { call: presentToolCall(message.content, message.tool), result: null, callContent: message.content, resultContent: null, status: 'pending', expanded, detailsId: `chat-tool-${message.id}`, timestamp: message.timestamp };
  }
  const result = presentToolResult(message.content, { tool: message.tool, kind: message.kind });
  return { call: presentToolCall('{}', message.tool), result, callContent: '', resultContent: message.content, status: result.status, expanded, detailsId: `chat-tool-${message.id}`, timestamp: message.timestamp };
}

export function adaptPendingInvocationToToolChip(pending: PendingCall & { summary?: string }, expanded: boolean): ToolChipPropsBag {
  const callContent = pending.summary ?? `${pending.tool} is running`;
  return { call: presentToolCall(callContent, pending.tool), result: null, callContent, resultContent: null, status: 'pending', expanded, detailsId: `pending-tool-${pending.id}`, timestamp: pending.started_at };
}
