import { createHash } from 'node:crypto';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, ConversationSessionId } from '../../schemas/index.js';
import type { LlmCompleteResult, ProviderPrivateContext, ToolCall } from '../../agents/llm-contracts.js';
import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
import type { CanonicalLlmInvocationInput } from './llm-invocation.js';
import { readConversationMessages } from './conversation-session.js';
import { appendConversationBatch, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';
export {
  loggedToolCallKey,
  sourceInputIdFromToolCallMessageId,
  sourceInputIdFromToolResultMessageId,
} from '../../schemas/message-identity.js';

export interface ToolSettlementRecord {
  session_id: ConversationSessionId;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  created_at: string;
}

export interface SyntheticFailedToolResultPayload {
  success: false;
  error: string;
  data?: unknown;
}

export type ProviderVisibleToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string; data?: unknown };

export interface LoggedToolCall {
  agent_id: string;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
}

export function appendLlmTurnStarted(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, options: { includeSystemPrompt?: boolean } = {}): AgentMessage[] {
  const messages: AgentMessage[] = [];
  if (options.includeSystemPrompt ?? true) {
    messages.push(agentMessageSchema.parse({
      id: `${input.inputId}:system-prompt`,
      session_id: input.sessionId,
      role: 'system',
      kind: 'system_prompt',
      content: input.systemPrompt,
      round_id: roundId('pre', `${input.inputId}:system-prompt`),
      message_index: 0,
      block_index: 0,
      timestamp: new Date().toISOString(),
    }));
  }
  messages.push(agentMessageSchema.parse({
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
  appendConversationBatch(conversations.projectRoot, messages, conversations.changes);
  return messages;
}

export function appendLlmTurnFinished(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, result: LlmCompleteResult): void {
  if (result.kind === 'message') {
    appendLlmTurnMessage(conversations, input, result.content);
    return;
  }
  result.tool_calls.forEach((toolCall, index) => {
    appendToolCallMessage(conversations, input, toolCall, index);
  });
}

export function appendLlmTurnMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string): AgentMessage {
  const message = assistantMessage(input, content, new Date().toISOString());
  appendOne(conversations, message);
  return message;
}

function assistantMessage(input: CanonicalLlmInvocationInput, content: string, timestamp: string): AgentMessage {
  return agentMessageSchema.parse({
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      round_id: roundId('assistant', input.inputId),
      message_index: 1,
      block_index: 0,
      timestamp,
    });
}

function providerPrivateResponsesMessage(input: CanonicalLlmInvocationInput, projectionMessageId: string, privateContext: ProviderPrivateContext): AgentMessage {
  if (privateContext.kind !== 'openai_responses') throw new Error(`Unsupported provider private context kind '${privateContext.kind}'.`);
  if (privateContext.source_input_id !== input.inputId) throw new Error(`Provider private context source_input_id '${privateContext.source_input_id}' does not match input '${input.inputId}'.`);
  return agentMessageSchema.parse({
    id: `${input.inputId}:provider-private:openai-responses`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'provider_private',
    content: JSON.stringify({ transport: 'openai-responses', source_input_id: input.inputId, projection_message_id: projectionMessageId, provider: privateContext.provider, model: privateContext.model, output: privateContext.output }),
    round_id: roundId('assistant', `${input.inputId}:provider-private`),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

export function appendLlmTurnMessageBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnMessage(conversations, input, content);
  const visible = assistantMessage(input, content, new Date().toISOString());
  const privateRow = providerPrivateResponsesMessage(input, visible.id, privateContext);
  visible.provider_projection = { kind: 'openai_responses', source_input_id: input.inputId, private_message_id: privateRow.id, projection_kind: 'assistant_message' };
  validateResponsesPairs(input.sessionId, [privateRow, visible]);
  appendVisibleBatch(conversations, [privateRow, visible]);
  return visible;
}

export function appendLlmTurnError(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, error: string): AgentMessage {
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
  appendOne(conversations, message);
  return message;
}

export function appendToolResult(conversations: ConversationFileContext, record: Omit<ToolSettlementRecord, 'created_at'>): ToolSettlementRecord & { message: AgentMessage } {
  const parsed: ToolSettlementRecord = { ...record, created_at: new Date().toISOString() };
  const message = toolResultAgentMessage(parsed);
  appendOne(conversations, message);
  return Object.assign(parsed, { message });
}

export function readLoggedToolCall(projectRoot: string, sessionId: ConversationSessionId, agentId: string, sourceInputId: string, toolCallId: string): LoggedToolCall {
  const matches = readConversationMessages(projectRoot, sessionId)
    .physicalRows
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

export function appendTerminalProjectedToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string }): AgentMessage {
  return appendSyntheticToolResult(conversations, {
    sessionId: record.sessionId,
    sourceInputId: record.sourceInputId,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    result: { projected: true },
  });
}

export function toolCallAgentMessage(input: CanonicalLlmInvocationInput, toolCall: ToolCall, index = 0, timestamp = new Date().toISOString()): AgentMessage {
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

export function appendLlmTurnToolCallBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnToolCall(conversations, input, toolCall);
  const visible = toolCallAgentMessage(input, toolCall, 0, new Date().toISOString());
  const privateRow = providerPrivateResponsesMessage(input, visible.id, privateContext);
  visible.provider_projection = { kind: 'openai_responses', source_input_id: input.inputId, private_message_id: privateRow.id, projection_kind: 'assistant_tool_call' };
  validateResponsesPairs(input.sessionId, [privateRow, visible]);
  appendVisibleBatch(conversations, [privateRow, visible]);
  return visible;
}

export function toolResultAgentMessage(record: ToolSettlementRecord): AgentMessage {
  return agentMessageSchema.parse({
    id: `${record.source_input_id}:tool-result:${record.tool_call_id}`,
    session_id: record.session_id,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(record.result),
    tool: record.tool_name,
    tool_call_id: record.tool_call_id,
    round_id: roundId('user', record.source_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: record.created_at,
  });
}

function appendSyntheticToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; result: unknown }): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${record.sourceInputId}:tool-result:${record.toolCallId}`,
    session_id: record.sessionId,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(record.result),
    tool: record.toolName,
    tool_call_id: record.toolCallId,
    round_id: roundId('user', record.sourceInputId),
    message_index: 2,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

export function appendProviderVisibleSyntheticToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; result: ProviderVisibleToolResult }): AgentMessage {
  return appendSyntheticToolResult(conversations, record);
}

export function appendProviderVisibleSyntheticFailedToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; error: string; data?: unknown }): AgentMessage {
  const payload: SyntheticFailedToolResultPayload = { success: false, error: record.error };
  if (record.data !== undefined) payload.data = record.data;
  return appendProviderVisibleSyntheticToolResult(conversations, { ...record, result: payload });
}

export function appendLlmTurnToolCall(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall): AgentMessage {
  return appendToolCallMessage(conversations, input, toolCall, 0);
}

function appendToolCallMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall, index: number): AgentMessage {
  const message = toolCallAgentMessage(input, toolCall, index);
  appendOne(conversations, message);
  return message;
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

export function appendModelRepairMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string): AgentMessage {
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
  appendOne(conversations, message);
  return message;
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function appendOne(conversations: ConversationFileContext, message: AgentMessage): void {
  appendConversationBatch(conversations.projectRoot, [message], conversations.changes);
}

function appendVisibleBatch(conversations: ConversationFileContext, messages: AgentMessage[]): void {
  appendConversationBatch(conversations.projectRoot, messages, conversations.changes);
}
