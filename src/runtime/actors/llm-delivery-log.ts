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

export type ToolDeliveryRecord = z.infer<typeof toolDeliveryRecordSchema>;

export function actorMessagesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'messages', `${encodeURIComponent(agentId)}.jsonl`);
}

export function actorToolDeliveriesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'tool-deliveries', `${encodeURIComponent(agentId)}.jsonl`);
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
  result.tool_calls.forEach((toolCall, index) => appendToolCallMessage(projectRoot, input, toolCall, index));
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
