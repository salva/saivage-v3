import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolCall } from '../../agents/llm-contracts.js';
import type { ProviderExchangeAttempt, ProviderExchangePayload } from '../../contracts/provider-exchange.js';
import { serializeProviderExchangePayload } from '../../contracts/provider-exchange.js';
import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { appendConversationMessage, appendProviderExchangeMessage, listConversationSessionIds, readActiveVersionMessages, readConversationMessages, type ConversationAppendResult } from './conversation-store.js';
import { agentIdFromSessionId, cardIdFromSessionId } from './ids.js';
import {
  loggedToolCallIdentity,
  loggedToolCallKey,
  loggedToolErrorIdentity,
  loggedToolResultIdentity,
} from '../../schemas/message-identity.js';
export {
  loggedToolCallKey,
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolErrorMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../../schemas/message-identity.js';

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

export interface SyntheticFailedToolResultPayload {
  success: false;
  error: string;
  data?: unknown;
}

export interface LoggedToolCall {
  agent_id: string;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
}

export function appendLlmTurnStarted(projectRoot: string, input: LlmInvocationInput, options: { includeSystemPrompt?: boolean } = {}): ConversationAppendResult[] {
  const results: ConversationAppendResult[] = [];
  if (options.includeSystemPrompt ?? true) {
    results.push(appendConversationMessage(projectRoot, {
      id: `${input.agentId}:system-prompt`,
      session_id: input.sessionId,
      role: 'system',
      kind: 'system_prompt',
      content: input.systemPrompt,
      round_id: roundId('pre', `${input.agentId}:system-prompt`),
      message_index: 0,
      block_index: 0,
      timestamp: new Date().toISOString(),
    }));
  }
  for (const message of input.turnMessages ?? []) results.push(appendConversationMessage(projectRoot, message));
  results.push(appendConversationMessage(projectRoot, {
    id: `${input.inputId}:started`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'llm_turn_started', inputId: input.inputId, role: input.role }),
    round_id: roundId('pre', input.inputId),
    message_index: 0,
    block_index: 0,
    timestamp: new Date().toISOString(),
  }));
  return results;
}

export function appendLlmTurnFinished(projectRoot: string, input: LlmInvocationInput, result: LlmCompleteResult): void {
  if (result.kind === 'message') {
    appendLlmTurnMessage(projectRoot, input, result.content);
    return;
  }
  result.tool_calls.forEach((toolCall, index) => {
    appendToolCallMessage(projectRoot, input, toolCall, index);
  });
}

export function appendLlmTurnMessage(projectRoot: string, input: LlmInvocationInput, content: string): AgentMessage & { appendResult: ConversationAppendResult } {
  const message = agentMessageSchema.parse({
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      round_id: roundId('assistant', input.inputId),
      message_index: 1,
      block_index: 0,
      timestamp: new Date().toISOString(),
    });
  const appendResult = appendConversationMessage(projectRoot, message);
  return Object.assign(message, { appendResult });
}

export function appendLlmTurnError(projectRoot: string, input: LlmInvocationInput, error: string): AgentMessage & { appendResult: ConversationAppendResult } {
  const message = agentMessageSchema.parse({
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
  const appendResult = appendConversationMessage(projectRoot, message);
  return Object.assign(message, { appendResult });
}

export function appendLlmProviderExchangeRows(projectRoot: string, input: LlmInvocationInput, attempts: ProviderExchangeAttempt[], assistantOutputIds: string[], assistantTurnBlockCount = 1): ConversationAppendResult[] {
  if (attempts.length === 0) return [];
  const results: ConversationAppendResult[] = [];
  const sorted = [...attempts].sort((a, b) => (a.attempt_index ?? -1) - (b.attempt_index ?? -1));
  sorted.forEach((attempt, index) => {
    if (attempt.source_input_id !== input.inputId) throw new Error(`provider_exchange source_input_id '${attempt.source_input_id}' does not match input '${input.inputId}'.`);
    if (attempt.attempt_index !== index) throw new Error(`provider_exchange attempt indexes for '${input.inputId}' must be consecutive 0..N.`);
    const payload = providerExchangePayload(attempt, assistantOutputIds);
    const id = `${input.inputId}:provider-exchange:${attempt.attempt_index}`;
    results.push(appendProviderExchangeMessage(projectRoot, agentMessageSchema.parse({
      id,
      session_id: input.sessionId,
      role: 'system',
      kind: 'provider_exchange',
      content: serializeProviderExchangePayload(payload),
      round_id: roundId('assistant', input.inputId),
      message_index: 1,
      block_index: assistantTurnBlockCount + attempt.attempt_index,
      timestamp: attempt.completed_at,
    })));
  });
  return results;
}

export function appendToolDelivery(projectRoot: string, record: Omit<ToolDeliveryRecord, 'delivery_id' | 'created_at'>): ToolDeliveryRecord & { appendResult: ConversationAppendResult } {
  const delivery: ToolDeliveryRecord = {
    ...record,
    delivery_id: `${record.agent_id}:${record.tool_call_id}:${record.delivery_input_id}`,
    created_at: new Date().toISOString(),
  };
  const parsed = toolDeliveryRecordSchema.parse(delivery);
  const appendResult = appendConversationMessage(projectRoot, toolResultAgentMessage(parsed));
  return Object.assign(parsed, { appendResult });
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

export function appendTerminalProjectedToolResult(projectRoot: string, record: { sessionId: string; sourceInputId: string; toolCallId: string; toolName: string }): AgentMessage & { appendResult: ConversationAppendResult } {
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
    const messages = readActiveVersionMessagesForSettlement(projectRoot, sessionId);
    const settledKeys = new Set<string>();
    for (const message of messages) {
      const result = validToolResultIdentity(message);
      if (result) settledKeys.add(loggedToolCallKey(result));
      const error = validToolErrorIdentity(message);
      if (error) settledKeys.add(loggedToolCallKey(error));
    }
    for (const message of messages) {
      if (message.kind !== 'tool_call' || !message.tool_call_id) continue;
      if (!message.tool) throw new Error(`Logged tool call '${message.id}' in session '${sessionId}' is missing a tool name.`);
      const callIdentity = validToolCallIdentity(message);
      if (!callIdentity) throw new Error(`Logged tool call '${message.id}' in session '${sessionId}' has malformed identity.`);
      const sourceInputId = callIdentity.source_input_id;
      const key = loggedToolCallKey(callIdentity);
      if (settledKeys.has(key) || preserveKeys.has(key)) continue;
      const payload = syntheticFailedToolResultPayload(message, reason);
      appendProviderVisibleSyntheticFailedToolResult(projectRoot, {
        sessionId,
        sourceInputId,
        toolCallId: message.tool_call_id,
        toolName: message.tool,
        error: payload.error,
        data: payload.data,
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

export function appendToolErrorSettlementResults(projectRoot: string): AbandonedToolCallRecord[] {
  const appended: AbandonedToolCallRecord[] = [];
  for (const sessionId of listConversationSessionIds(projectRoot)) {
    const messages = readActiveVersionMessagesForSettlement(projectRoot, sessionId);
    const resultKeys = new Set<string>();
    const errorByKey = new Map<string, AgentMessage>();
    for (const message of messages) {
      const result = validToolResultIdentity(message);
      if (result) resultKeys.add(loggedToolCallKey(result));
      const error = validToolErrorIdentity(message);
      if (error) errorByKey.set(loggedToolCallKey(error), message);
    }
    for (const message of messages) {
      if (message.kind !== 'tool_call' || !message.tool) continue;
      const callIdentity = validToolCallIdentity(message);
      if (!callIdentity) throw new Error(`Logged tool call '${message.id}' in session '${sessionId}' has malformed identity.`);
      const key = loggedToolCallKey(callIdentity);
      const toolError = errorByKey.get(key);
      if (!toolError || resultKeys.has(key)) continue;
      const errorText = toolError.content || `Recovered prior ${toolError.tool ?? message.tool} tool error before provider reissue.`;
      appendProviderVisibleSyntheticFailedToolResult(projectRoot, {
        sessionId,
        sourceInputId: callIdentity.source_input_id,
        toolCallId: callIdentity.tool_call_id,
        toolName: message.tool,
        error: errorText,
        data: syntheticFailedToolResultPayload(message, errorText).data,
      });
      resultKeys.add(key);
      appended.push({
        agent_id: agentIdFromSessionId(sessionId),
        card_id: cardIdFromSessionId(sessionId),
        source_input_id: callIdentity.source_input_id,
        tool_call_id: callIdentity.tool_call_id,
        tool_name: message.tool,
        error: errorText,
      });
    }
  }
  return appended;
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

function appendSyntheticToolResult(projectRoot: string, record: { sessionId: string; sourceInputId: string; toolCallId: string; toolName: string; result: unknown }): AgentMessage & { appendResult: ConversationAppendResult } {
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
  const appendResult = appendConversationMessage(projectRoot, message);
  return Object.assign(message, { appendResult });
}

export function appendProviderVisibleSyntheticFailedToolResult(projectRoot: string, record: { sessionId: string; sourceInputId: string; toolCallId: string; toolName: string; error: string; data?: unknown }): AgentMessage & { appendResult: ConversationAppendResult } {
  const payload: SyntheticFailedToolResultPayload = { success: false, error: record.error };
  if (record.data !== undefined) payload.data = record.data;
  return appendSyntheticToolResult(projectRoot, { ...record, result: payload });
}

function readActiveVersionMessagesForSettlement(projectRoot: string, sessionId: string): AgentMessage[] {
  return readActiveVersionMessages(projectRoot, sessionId);
}

function validToolCallIdentity(message: AgentMessage) {
  try { return loggedToolCallIdentity(message); } catch { return null; }
}

function validToolResultIdentity(message: AgentMessage) {
  try { return loggedToolResultIdentity(message); } catch { return null; }
}

function validToolErrorIdentity(message: AgentMessage) {
  try { return loggedToolErrorIdentity(message); } catch { return null; }
}

function syntheticFailedToolResultPayload(message: AgentMessage, reason: string): SyntheticFailedToolResultPayload {
  const toolName = message.tool ?? 'unknown_tool';
  const args = toolArguments(message);
  if (toolName === 'activate_card') {
    const childCardId = stringArg(args, 'child_card_id') ?? stringArg(args, 'card_id');
    return { success: false, error: 'Activation was interrupted during runtime recovery.', data: { tool: toolName, child_card_id: childCardId, instruction: 'inspect child card state before retrying' } };
  }
  if (toolName === 'run_command' || toolName === 'wait_process' || toolName === 'kill_process') {
    const processId = stringArg(args, 'process_id') ?? stringArg(args, 'processId') ?? stringArg(args, 'id');
    return { success: false, error: 'Process tool call was interrupted; process no longer exists.', data: { tool: toolName, process_id: processId, instruction: 'process no longer exists, launch a new one if needed' } };
  }
  const targetPath = stringArg(args, 'path') ?? stringArg(args, 'file_path') ?? stringArg(args, 'target_path');
  if (targetPath) return { success: false, error: 'Workspace tool call was interrupted; inspect the target path before retrying.', data: { tool: toolName, target_path: targetPath } };
  return { success: false, error: reason, data: { tool: toolName } };
}

function toolArguments(message: AgentMessage): Record<string, unknown> {
  try {
    return parseToolCallMessage(JSON.parse(message.content)).args;
  } catch {
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function appendLlmTurnToolCall(projectRoot: string, input: LlmInvocationInput, toolCall: ToolCall): AgentMessage & { appendResult: ConversationAppendResult } {
  return appendToolCallMessage(projectRoot, input, toolCall, 0);
}

function appendToolCallMessage(projectRoot: string, input: LlmInvocationInput, toolCall: ToolCall, index: number): AgentMessage & { appendResult: ConversationAppendResult } {
  const message = toolCallAgentMessage(input, toolCall, index);
  const appendResult = appendConversationMessage(projectRoot, message);
  return Object.assign(message, { appendResult });
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

export function appendModelRepairMessage(projectRoot: string, input: LlmInvocationInput, content: string): AgentMessage & { appendResult: ConversationAppendResult } {
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
  const appendResult = appendConversationMessage(projectRoot, message);
  return Object.assign(message, { appendResult });
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function providerExchangePayload(attempt: ProviderExchangeAttempt, assistantOutputIds: string[]): ProviderExchangePayload {
  if (attempt.attempt_index === undefined) throw new Error(`provider_exchange for '${attempt.source_input_id}' is missing attempt_index.`);
  if (attempt.status === 'ok') {
    return { ...attempt, attempt_index: attempt.attempt_index, assistant_output_ids: assistantOutputIds } as ProviderExchangePayload;
  }
  return { ...attempt, attempt_index: attempt.attempt_index } as ProviderExchangePayload;
}
