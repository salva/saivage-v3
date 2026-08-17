import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, ConversationSessionId } from '../../schemas/index.js';
import { deterministicRoundId } from '../../schemas/round-id-server.js';
import type { ProviderPrivateContext, ToolCall } from '../../agents/llm-contracts.js';
import type { CanonicalLlmInvocationInput } from './llm-invocation.js';
import { appendConversationBatch, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';
interface ToolSettlementRecord {
  session_id: ConversationSessionId;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  created_at: string;
}

interface SyntheticFailedToolResultPayload {
  success: false;
  error: string;
  data?: unknown;
}

export function appendLlmTurnStarted(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput): AgentMessage[] {
  const messages: AgentMessage[] = [agentMessageSchema.parse({
    id: `${input.inputId}:started`,
    session_id: input.sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'llm_turn_started', inputId: input.inputId, agent_name: input.agentName }),
    round_id: deterministicRoundId('pre', input.inputId),
    message_index: 0,
    block_index: 0,
    timestamp: new Date().toISOString(),
  })];
  appendConversationBatch(conversations, messages);
  return messages;
}

function appendLlmTurnMessage(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string): AgentMessage {
  const message = buildLlmTurnMessage(input, content);
  appendOne(conversations, message);
  return message;
}

export function buildLlmTurnMessage(input: CanonicalLlmInvocationInput, content: string, timestamp = new Date().toISOString()): AgentMessage {
  return agentMessageSchema.parse({
      id: `${input.inputId}:message`,
      session_id: input.sessionId,
      role: 'assistant',
      kind: 'text',
      content,
      round_id: deterministicRoundId('assistant', input.inputId),
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
    round_id: deterministicRoundId('assistant', `${input.inputId}:provider-private`),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

export function appendLlmTurnMessageBatch(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, content: string, privateContext?: ProviderPrivateContext): AgentMessage {
  if (!privateContext) return appendLlmTurnMessage(conversations, input, content);
  const visible = buildLlmTurnMessage(input, content);
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
    round_id: deterministicRoundId('assistant', input.inputId),
    message_index: 1,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

export function appendToolResult(conversations: ConversationFileContext, record: Omit<ToolSettlementRecord, 'created_at'>): ToolSettlementRecord {
  const parsed: ToolSettlementRecord = { ...record, created_at: new Date().toISOString() };
  const message = buildToolResultMessage(parsed);
  appendOne(conversations, message);
  return parsed;
}

function toolCallAgentMessage(input: CanonicalLlmInvocationInput, toolCall: ToolCall, index = 0, timestamp = new Date().toISOString()): AgentMessage {
  return agentMessageSchema.parse({
    id: `${input.inputId}:tool-call:${toolCall.id}`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'tool_call',
    content: JSON.stringify(toolCallAgentContent(toolCall)),
    tool: toolCall.function.name,
    tool_call_id: toolCall.id,
    round_id: deterministicRoundId('assistant', input.inputId),
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

export function buildToolResultMessage(record: Omit<ToolSettlementRecord, 'created_at'> & { created_at?: string }): AgentMessage {
  const complete = { ...record, created_at: record.created_at ?? new Date().toISOString() };
  return agentMessageSchema.parse({
    id: `${complete.source_input_id}:tool-result:${complete.tool_call_id}`,
    session_id: complete.session_id,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(complete.result),
    tool: complete.tool_name,
    tool_call_id: complete.tool_call_id,
    round_id: deterministicRoundId('user', complete.source_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: complete.created_at,
  });
}

export function appendProviderVisibleSyntheticFailedToolResult(conversations: ConversationFileContext, record: { sessionId: ConversationSessionId; sourceInputId: string; toolCallId: string; toolName: string; error: string; data?: unknown }): void {
  const payload: SyntheticFailedToolResultPayload = { success: false, error: record.error };
  if (record.data !== undefined) payload.data = record.data;
  const message = agentMessageSchema.parse({
    id: `${record.sourceInputId}:tool-result:${record.toolCallId}`,
    session_id: record.sessionId,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(payload),
    tool: record.toolName,
    tool_call_id: record.toolCallId,
    round_id: deterministicRoundId('user', record.sourceInputId),
    message_index: 2,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
}

function appendLlmTurnToolCall(conversations: ConversationFileContext, input: CanonicalLlmInvocationInput, toolCall: ToolCall): AgentMessage {
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
    round_id: deterministicRoundId('user', input.inputId),
    message_index: 3,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
  appendOne(conversations, message);
  return message;
}

function appendOne(conversations: ConversationFileContext, message: AgentMessage): void {
  appendConversationBatch(conversations, [message]);
}

function appendVisibleBatch(conversations: ConversationFileContext, messages: AgentMessage[]): void {
  appendConversationBatch(conversations, messages);
}
