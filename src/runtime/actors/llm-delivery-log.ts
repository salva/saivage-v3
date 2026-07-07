import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolCall } from '../../agents/llm-contracts.js';
import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { appendConversationMessage, listConversationSessionIds, readConversationMessages } from './conversation-store.js';
import { agentIdFromSessionId, cardIdFromSessionId } from './ids.js';

const toolDeliveryRecordSchema = z.object({
  delivery_id: z.string().min(1),
  agent_id: z.string().min(1),
  session_id: z.string().min(1),
  source_input_id: z.string().min(1),
  delivery_input_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  result: z.unknown(),
  created_at: z.string().datetime(),
});

export type ToolDeliveryRecord = z.infer<typeof toolDeliveryRecordSchema>;

export interface AbandonedToolCallRecord {
  agent_id: string;
  card_id?: string;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  error: string;
}

export interface LoggedToolCall {
  agent_id: string;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
}

export function appendLlmTurnStarted(projectRoot: string, input: LlmInvocationInput, options: { includeSystemPrompt?: boolean } = {}): void {
  if (options.includeSystemPrompt ?? true) {
    appendConversationMessage(projectRoot, {
      id: `${input.agentId}:system-prompt`,
      session_id: input.sessionId,
      role: 'system',
      kind: 'system_prompt',
      content: input.systemPrompt,
      round_id: roundId('pre', `${input.agentId}:system-prompt`),
      message_index: 0,
      block_index: 0,
      timestamp: new Date().toISOString(),
    });
  }
  for (const message of input.turnMessages ?? []) appendConversationMessage(projectRoot, message);
  appendConversationMessage(projectRoot, {
    id: `${input.inputId}:started`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'llm_turn_started', inputId: input.inputId, role: input.role }),
    round_id: roundId('pre', input.inputId),
    message_index: 0,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

export function appendLlmTurnFinished(projectRoot: string, input: LlmInvocationInput, result: LlmCompleteResult): void {
  if (result.kind === 'message') {
    appendConversationMessage(projectRoot, {
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content: result.content,
      round_id: roundId('assistant', input.inputId),
      message_index: 1,
      block_index: 0,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  result.tool_calls.forEach((toolCall, index) => {
    appendToolCallMessage(projectRoot, input, toolCall, index);
  });
}

export function appendLlmTurnError(projectRoot: string, input: LlmInvocationInput, error: string): void {
  appendConversationMessage(projectRoot, {
    id: `${input.inputId}:error`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'model_issue',
    content: error,
    round_id: roundId('assistant', input.inputId),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

export function appendToolDelivery(projectRoot: string, record: Omit<ToolDeliveryRecord, 'delivery_id' | 'created_at'>): ToolDeliveryRecord {
  const delivery: ToolDeliveryRecord = {
    ...record,
    delivery_id: `${record.agent_id}:${record.tool_call_id}:${record.delivery_input_id}`,
    created_at: new Date().toISOString(),
  };
  const parsed = toolDeliveryRecordSchema.parse(delivery);
  appendConversationMessage(projectRoot, toolResultAgentMessage(parsed));
  return parsed;
}

export function readLoggedToolCall(projectRoot: string, sessionId: string, agentId: string, sourceInputId: string, toolCallId: string): LoggedToolCall {
  const matches = readConversationMessages(projectRoot, sessionId)
    .filter((message) => message.session_id === sessionId && message.kind === 'tool_call' && message.id === `${sourceInputId}:tool-call:${toolCallId}` && message.tool_call_id === toolCallId);
  if (matches.length === 0) throw new Error(`Logged tool call '${toolCallId}' for '${agentId}' input '${sourceInputId}' was not found.`);
  if (matches.length > 1) throw new Error(`Logged tool call '${toolCallId}' for '${agentId}' input '${sourceInputId}' is duplicated.`);
  const [message] = matches;
  if (!message.tool) throw new Error(`Logged tool call '${toolCallId}' for '${agentId}' is missing a tool name.`);
  try {
    const call = parseToolCallMessage(JSON.parse(message.content));
    return { agent_id: agentId, source_input_id: sourceInputId, tool_call_id: call.id, tool_name: call.name, args: call.args };
  } catch (error) {
    throw new Error(`Logged tool call '${toolCallId}' for '${agentId}' has malformed JSON arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function appendTerminalProjectedToolResult(projectRoot: string, record: { sessionId: string; sourceInputId: string; toolCallId: string; toolName: string }): AgentMessage {
  return appendSyntheticToolResult(projectRoot, {
    sessionId: record.sessionId,
    sourceInputId: record.sourceInputId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    result: { projected: true },
  });
}

export function abandonStalePendingToolCalls(projectRoot: string, reason = 'Runtime restarted before the pending tool call reached a terminal delivery state.', preserveKeys: ReadonlySet<string> = new Set()): AbandonedToolCallRecord[] {
  const abandoned: AbandonedToolCallRecord[] = [];
  for (const sessionId of listConversationSessionIds(projectRoot)) {
    const messages = readConversationMessages(projectRoot, sessionId);
    const settledKeys = new Set<string>();
    for (const message of messages) {
      if (message.kind !== 'tool_result' || !message.tool_call_id) continue;
      const sourceInputId = sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id);
      settledKeys.add(loggedToolCallKey({ session_id: sessionId, source_input_id: sourceInputId, tool_call_id: message.tool_call_id }));
    }
    for (const message of messages) {
      if (message.kind !== 'tool_call' || !message.tool_call_id) continue;
      if (!message.tool) throw new Error(`Logged tool call '${message.id}' in session '${sessionId}' is missing a tool name.`);
      const sourceInputId = sourceInputIdFromToolCallMessageId(message.id);
      const key = loggedToolCallKey({ session_id: sessionId, source_input_id: sourceInputId, tool_call_id: message.tool_call_id });
      if (settledKeys.has(key) || preserveKeys.has(key)) continue;
      appendSyntheticToolResult(projectRoot, {
        sessionId,
        sourceInputId,
        toolCallId: message.tool_call_id,
        toolName: message.tool,
        result: { success: false, error: reason },
      });
      settledKeys.add(key);
      abandoned.push({
        agent_id: agentIdFromSessionId(sessionId),
        card_id: cardIdFromSessionId(sessionId),
        source_input_id: sourceInputId,
        tool_call_id: message.tool_call_id,
        tool_name: message.tool,
        error: reason,
      });
    }
  }
  return abandoned;
}

export function loggedToolCallKey(record: { session_id: string; source_input_id: string; tool_call_id: string }): string {
  return [record.session_id, record.source_input_id, record.tool_call_id].join(':');
}

export function sourceInputIdFromToolCallMessageId(id: string): string {
  const delimiter = ':tool-call:';
  const index = id.indexOf(delimiter);
  if (index <= 0) throw new Error(`Malformed tool_call message id '${id}': missing '${delimiter}'.`);
  return id.slice(0, index);
}

export function sourceInputIdFromToolResultMessageId(id: string, toolCallId?: string): string {
  const suffix = toolCallId ? `:tool-result:${toolCallId}` : ':tool-result:';
  const suffixIndex = toolCallId ? id.lastIndexOf(suffix) : id.indexOf(suffix);
  if (suffixIndex <= 0) throw new Error(`Malformed tool_result message id '${id}': missing '${suffix}'.`);
  const deliveryInputId = id.slice(0, suffixIndex);
  const deliveryMarker = deliveryInputId.lastIndexOf(':tool:');
  if (deliveryMarker <= 0) throw new Error(`Malformed tool_result message id '${id}': missing delivery input ':tool:<counter>' segment.`);
  const counter = deliveryInputId.slice(deliveryMarker + ':tool:'.length);
  if (!/^\d+$/.test(counter)) throw new Error(`Malformed tool_result message id '${id}': delivery counter '${counter}' is not numeric.`);
  return deliveryInputId.slice(0, deliveryMarker);
}

export function toolCallAgentMessage(input: LlmInvocationInput, toolCall: ToolCall, index = 0, timestamp = new Date().toISOString()): AgentMessage {
  return agentMessageSchema.parse({
    id: `${input.inputId}:tool-call:${toolCall.id}`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'tool_call',
    content: JSON.stringify(toolCallAgentContent(toolCall)),
    tool: toolCall.function.name,
    tool_call_id: toolCall.id,
    round_id: roundId('assistant', input.inputId),
    message_index: 1,
    block_index: index,
    timestamp,
  });
}

export function toolResultAgentMessage(record: ToolDeliveryRecord): AgentMessage {
  return agentMessageSchema.parse({
    id: `${record.delivery_input_id}:tool-result:${record.tool_call_id}`,
    session_id: record.session_id,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(record.result),
    tool: record.tool_name,
    tool_call_id: record.tool_call_id,
    round_id: roundId('user', record.delivery_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: record.created_at,
  });
}

function appendSyntheticToolResult(projectRoot: string, record: { sessionId: string; sourceInputId: string; toolCallId: string; toolName: string; result: unknown }): AgentMessage {
  const deliveryInputId = `${record.sourceInputId}:tool:0`;
  const message = agentMessageSchema.parse({
    id: `${deliveryInputId}:tool-result:${record.toolCallId}`,
    session_id: record.sessionId,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(record.result),
    tool: record.toolName,
    tool_call_id: record.toolCallId,
    round_id: roundId('user', deliveryInputId),
    message_index: 2,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendConversationMessage(projectRoot, message);
  return message;
}

function appendToolCallMessage(projectRoot: string, input: LlmInvocationInput, toolCall: ToolCall, index: number): void {
  appendConversationMessage(projectRoot, toolCallAgentMessage(input, toolCall, index));
}

function toolCallAgentContent(toolCall: ToolCall): unknown {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      },
    ],
  };
}

export function appendModelRepairMessage(projectRoot: string, input: LlmInvocationInput, content: string): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${input.inputId}:repair`,
    session_id: input.sessionId,
    role: 'user',
    kind: 'model_repair',
    content,
    round_id: roundId('user', input.inputId),
    message_index: 3,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendConversationMessage(projectRoot, message);
  return message;
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
