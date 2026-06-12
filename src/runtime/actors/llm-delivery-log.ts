import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { appendSyncIdempotentByKey } from '../../persistence/index.js';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolCall } from '../../agents/llm-contracts.js';
import type { LlmInvocationInput } from './llm-runner.js';

const toolDeliveryRecordSchema = z.object({
  delivery_id: z.string().min(1),
  agent_id: z.string().min(1),
  source_input_id: z.string().min(1),
  delivery_input_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  result: z.unknown(),
  created_at: z.string().datetime(),
});

const toolCallStatusRecordSchema = z.object({
  transition_id: z.string().min(1),
  agent_id: z.string().min(1),
  source_input_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  status: z.enum(['pending', 'delivered', 'errored', 'abandoned']),
  delivery_input_id: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  created_at: z.string().datetime(),
});

export type ToolDeliveryRecord = z.infer<typeof toolDeliveryRecordSchema>;
export type ToolCallStatusRecord = z.infer<typeof toolCallStatusRecordSchema>;

export function actorMessagesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'messages', `${encodeURIComponent(agentId)}.jsonl`);
}

export function actorToolDeliveriesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'tool-deliveries', `${encodeURIComponent(agentId)}.jsonl`);
}

export function actorToolCallStatusesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'tool-call-statuses', `${encodeURIComponent(agentId)}.jsonl`);
}

export function appendLlmTurnStarted(projectRoot: string, input: LlmInvocationInput): void {
  appendActorMessage(projectRoot, input.agentId, {
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
    appendActorMessage(projectRoot, input.agentId, {
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
    appendToolCallStatus(projectRoot, {
      agent_id: input.agentId,
      source_input_id: input.inputId,
      tool_call_id: toolCall.id,
      tool_name: toolCall.function.name,
      status: 'pending',
    });
  });
}

export function appendLlmTurnError(projectRoot: string, input: LlmInvocationInput, error: string): void {
  appendActorMessage(projectRoot, input.agentId, {
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
  appendSyncIdempotentByKey(actorToolDeliveriesPath(projectRoot, parsed.agent_id), parsed, 'delivery_id');
  appendActorMessage(projectRoot, parsed.agent_id, {
    id: `${parsed.delivery_input_id}:tool-result:${parsed.tool_call_id}`,
    session_id: parsed.agent_id,
    role: 'tool',
    kind: 'tool_result',
    content: JSON.stringify(parsed.result),
    tool: parsed.tool_name,
    tool_call_id: parsed.tool_call_id,
    round_id: roundId('user', parsed.delivery_input_id),
    message_index: 2,
    block_index: 0,
    timestamp: parsed.created_at,
  });
  appendToolCallStatus(projectRoot, {
    agent_id: parsed.agent_id,
    source_input_id: parsed.source_input_id,
    tool_call_id: parsed.tool_call_id,
    tool_name: parsed.tool_name,
    status: 'delivered',
    delivery_input_id: parsed.delivery_input_id,
  });
  return parsed;
}

export function appendToolCallStatus(projectRoot: string, record: Omit<ToolCallStatusRecord, 'transition_id' | 'created_at'>): ToolCallStatusRecord {
  const statusRecord: ToolCallStatusRecord = {
    ...record,
    transition_id: toolStatusTransitionId(record),
    created_at: new Date().toISOString(),
  };
  const parsed = toolCallStatusRecordSchema.parse(statusRecord);
  appendSyncIdempotentByKey(actorToolCallStatusesPath(projectRoot, parsed.agent_id), parsed, 'transition_id');
  return parsed;
}

function appendToolCallMessage(projectRoot: string, input: LlmInvocationInput, toolCall: ToolCall, index: number): void {
  appendActorMessage(projectRoot, input.agentId, {
    id: `${input.inputId}:tool-call:${toolCall.id}`,
    session_id: input.sessionId,
    role: 'assistant',
    kind: 'tool_call',
    content: toolCall.function.arguments,
    tool: toolCall.function.name,
    tool_call_id: toolCall.id,
    round_id: roundId('assistant', input.inputId),
    message_index: 1,
    block_index: index,
    timestamp: new Date().toISOString(),
  });
}

function appendActorMessage(projectRoot: string, agentId: string, message: AgentMessage): void {
  const parsed = agentMessageSchema.parse(message);
  appendSyncIdempotentByKey(actorMessagesPath(projectRoot, agentId), parsed, 'id');
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function toolStatusTransitionId(record: Omit<ToolCallStatusRecord, 'transition_id' | 'created_at'>): string {
  return [record.agent_id, record.source_input_id, record.tool_call_id, record.status, record.delivery_input_id ?? '', record.error ?? ''].join(':');
}
