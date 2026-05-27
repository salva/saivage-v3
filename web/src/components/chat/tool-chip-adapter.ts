import type { ConversationEntry, PendingCall } from '../../api/types';
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

export function adaptChatMessageToToolChip(call: ConversationEntry, result: ConversationEntry | null, expanded: boolean): ToolChipPropsBag {
  if (call.kind !== 'tool_call') {
    throw new Error(`ToolChip adapter expected a tool_call message, received ${call.kind}.`);
  }
  if (result !== null) {
    if (result.kind !== 'tool_result' && result.kind !== 'tool_error') {
      throw new Error(`ToolChip adapter expected a tool result/error message, received ${result.kind}.`);
    }
    if (call.tool_call_id && result.tool_call_id && result.tool_call_id !== call.tool_call_id) {
      throw new Error(`ToolChip adapter received mismatched tool_call_id values: ${call.tool_call_id} and ${result.tool_call_id}.`);
    }
  }

  const callPres = presentToolCall(call.content, call.tool);
  const resultPres = result ? presentToolResult(result.content, { tool: result.tool, kind: result.kind }) : null;
  return {
    call: callPres,
    result: resultPres,
    callContent: call.content,
    resultContent: result?.content ?? null,
    status: result ? resultPres!.status : 'pending',
    expanded,
    detailsId: `chat-tool-${call.id}`,
    timestamp: call.timestamp,
  };
}

export function adaptPendingInvocationToToolChip(pending: PendingCall & { summary?: string }, expanded: boolean): ToolChipPropsBag {
  const summary = pending.summary ?? `${pending.tool} is running`;
  const callContent = JSON.stringify({ tool: pending.tool, summary });
  return { call: presentToolCall(callContent, pending.tool), result: null, callContent, resultContent: null, status: 'pending', expanded, detailsId: `pending-tool-${pending.id}`, timestamp: pending.started_at };
}
