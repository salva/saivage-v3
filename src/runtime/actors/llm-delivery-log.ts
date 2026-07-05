import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { appendSyncIdempotentByKey } from '../../persistence/index.js';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { LlmCompleteResult, ToolCall } from '../../agents/llm-contracts.js';
import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import { appendConversationMessage, readConversationMessages } from './conversation-store.js';

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

const toolCallStatusRecordSchema = z.object({
  transition_id: z.string().min(1),
  agent_id: z.string().min(1),
  source_input_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  status: z.enum(['pending', 'delivered', 'errored', 'abandoned', 'terminal_projected']),
  delivery_input_id: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  created_at: z.string().datetime(),
});

export type ToolDeliveryRecord = z.infer<typeof toolDeliveryRecordSchema>;
export type ToolCallStatusRecord = z.infer<typeof toolCallStatusRecordSchema>;

export interface LoggedToolCall {
  agent_id: string;
  source_input_id: string;
  tool_call_id: string;
  tool_name: string;
  args: unknown;
}

export function actorToolDeliveriesPath(projectRoot: string, agentId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'tool-deliveries', `${encodeURIComponent(agentId)}.jsonl`);
}

function actorToolCallStatusesDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'agents', 'tool-call-statuses');
}

export function actorToolCallStatusesPath(projectRoot: string, agentId: string): string {
  return join(actorToolCallStatusesDir(projectRoot), `${encodeURIComponent(agentId)}.jsonl`);
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
  appendSyncIdempotentByKey(actorToolDeliveriesPath(projectRoot, parsed.agent_id), parsed, 'delivery_id');
  appendConversationMessage(projectRoot, toolResultAgentMessage(parsed));
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

export function readToolCallStatuses(projectRoot: string, agentId?: string): ToolCallStatusRecord[] {
  const paths = agentId ? [actorToolCallStatusesPath(projectRoot, agentId)] : actorToolCallStatusPaths(projectRoot);
  return paths.flatMap((path) => readToolCallStatusPath(path));
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

export function appendTerminalToolProjectedStatus(projectRoot: string, record: Omit<ToolCallStatusRecord, 'transition_id' | 'created_at' | 'status'>): ToolCallStatusRecord {
  return appendToolCallStatus(projectRoot, { ...record, status: 'terminal_projected' });
}

export function abandonStalePendingToolCalls(projectRoot: string, reason = 'Runtime restarted before the pending tool call reached a terminal delivery state.'): ToolCallStatusRecord[] {
  const records = readToolCallStatuses(projectRoot);
  const terminalKeys = new Set(records
    .filter((record) => record.status === 'delivered' || record.status === 'errored' || record.status === 'abandoned' || record.status === 'terminal_projected')
    .map(toolCallKey));
  const abandoned: ToolCallStatusRecord[] = [];
  for (const record of records) {
    if (record.status !== 'pending') continue;
    if (terminalKeys.has(toolCallKey(record))) continue;
    abandoned.push(appendToolCallStatus(projectRoot, {
      agent_id: record.agent_id,
      source_input_id: record.source_input_id,
      tool_call_id: record.tool_call_id,
      tool_name: record.tool_name,
      status: 'abandoned',
      error: reason,
    }));
    terminalKeys.add(toolCallKey(record));
  }
  return abandoned;
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

function actorToolCallStatusPaths(projectRoot: string): string[] {
  const dir = actorToolCallStatusesDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function readToolCallStatusPath(path: string): ToolCallStatusRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => toolCallStatusRecordSchema.parse(JSON.parse(line)));
}

function toolCallKey(record: Pick<ToolCallStatusRecord, 'agent_id' | 'source_input_id' | 'tool_call_id'>): string {
  return [record.agent_id, record.source_input_id, record.tool_call_id].join(':');
}

function toolStatusTransitionId(record: Omit<ToolCallStatusRecord, 'transition_id' | 'created_at'>): string {
  return [record.agent_id, record.source_input_id, record.tool_call_id, record.status, record.delivery_input_id ?? '', record.error ?? ''].join(':');
}
