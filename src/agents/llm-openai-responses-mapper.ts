import type { AgentMessage } from '../schemas/index.js';
import { parseToolCallMessageForModel } from '../contracts/persisted-tool-call.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolResultMessageId } from '../schemas/message-identity.js';
import type { ProviderConversationProjection } from './llm-contracts.js';

export interface OpenAIResponsesPrivateRowContent {
  transport: 'openai-responses';
  source_input_id: string;
  projection_message_id: string;
  provider: string;
  model: string;
  output: unknown[];
}

type ResponsesInputItem = Record<string, unknown>;

export function responsesInputFromProviderConversation(providerConversation: ProviderConversationProjection): ResponsesInputItem[] {
  validateResponsesPairs(providerConversation.sourceSessionId, providerConversation.messages);
  const input: ResponsesInputItem[] = [];
  const privateByProjection = new Map<string, OpenAIResponsesPrivateRowContent>();
  for (const message of providerConversation.messages) {
    if (message.kind === 'provider_private') {
      const row = parsePrivateContent(message);
      privateByProjection.set(row.projection_message_id, row);
    }
  }
  const emittedFunctionCalls = new Map<string, { sourceInputId: string; callId: string }>();
  const settled = new Set<string>();
  for (const message of providerConversation.messages) {
    if (message.kind === 'system_prompt' || message.kind === 'activity' || message.kind === 'model_issue' || message.kind === 'model_recovered') continue;
    if (message.kind === 'provider_private') continue;
    if (message.provider_projection?.kind === 'openai_responses') {
      const row = privateByProjection.get(message.id);
      if (!row) throw new Error(`Responses projection '${message.id}' is missing private row '${message.provider_projection.private_message_id}'.`);
      for (const item of row.output) {
        input.push(item as ResponsesInputItem);
        if (isFunctionCallItem(item)) emittedFunctionCalls.set(toolPairKey(row.source_input_id, item.call_id), { sourceInputId: row.source_input_id, callId: item.call_id });
      }
      continue;
    }
    if (message.kind === 'tool_result') {
      const sourceInputId = sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id ?? '');
      const callId = message.tool_call_id;
      if (!callId) throw new Error(`Responses tool settlement '${message.id}' is missing tool_call_id.`);
      const key = toolPairKey(sourceInputId, callId);
      if (!emittedFunctionCalls.has(key)) throw new Error(`Responses tool settlement '${message.id}' has no prior function_call '${callId}' for input '${sourceInputId}'.`);
      if (settled.has(key)) throw new Error(`Responses tool settlement for function_call '${callId}' on input '${sourceInputId}' is duplicated.`);
      settled.add(key);
      input.push({ type: 'function_call_output', call_id: callId, output: message.content });
      continue;
    }
    if (message.kind === 'tool_call') {
      const call = parseToolCallMessageForModel(JSON.parse(message.content));
      const sourceInputId = sourceInputIdFromToolCallMessageId(message.id, call.id);
      emittedFunctionCalls.set(toolPairKey(sourceInputId, call.id), { sourceInputId, callId: call.id });
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      continue;
    }
    if (message.kind === 'context_compaction') throw new Error(`Responses provider conversation contains compaction metadata row '${message.id}'.`);
    if (message.kind === 'text' && message.role === 'system') continue;
    if (message.kind === 'text' || message.kind === 'model_repair') {
      input.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] });
      continue;
    }
    if (message.kind !== 'activity') throw new Error(`Unsupported Responses replay row kind '${message.kind}' for '${message.id}'.`);
  }
  for (const { sourceInputId, callId } of emittedFunctionCalls.values()) {
    const key = toolPairKey(sourceInputId, callId);
    if (!settled.has(key)) throw new Error(`Responses replay contains unpaired function_call '${callId}' for input '${sourceInputId}'.`);
  }
  return input;
}

export function parsePrivateContent(message: AgentMessage): OpenAIResponsesPrivateRowContent {
  if (message.kind !== 'provider_private') throw new Error(`Message '${message.id}' is not a provider_private row.`);
  const parsed = JSON.parse(message.content) as OpenAIResponsesPrivateRowContent;
  if (parsed.transport !== 'openai-responses') throw new Error(`Provider private row '${message.id}' has unsupported transport.`);
  if (!parsed.source_input_id || !parsed.projection_message_id || !parsed.provider || !parsed.model || !Array.isArray(parsed.output)) throw new Error(`Provider private row '${message.id}' is malformed.`);
  return parsed;
}

export function validateResponsesPairs(sourceSessionId: string, messages: AgentMessage[]): void {
  const privateById = new Map<string, { message: AgentMessage; content: OpenAIResponsesPrivateRowContent }>();
  const visibleByInput = new Map<string, AgentMessage[]>();
  const privateByInput = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    if (message.session_id !== sourceSessionId) throw new Error(`Responses projection row '${message.id}' belongs to session '${message.session_id}', not source session '${sourceSessionId}'.`);
    if (message.kind === 'provider_private') {
      const content = parsePrivateContent(message);
      privateById.set(message.id, { message, content });
      const list = privateByInput.get(content.source_input_id) ?? [];
      list.push(message);
      privateByInput.set(content.source_input_id, list);
    }
    if (message.provider_projection?.kind === 'openai_responses') {
      const list = visibleByInput.get(message.provider_projection.source_input_id) ?? [];
      list.push(message);
      visibleByInput.set(message.provider_projection.source_input_id, list);
    }
  }
  for (const [sourceInputId, rows] of privateByInput) if (rows.length !== 1) throw new Error(`Responses private rows for input '${sourceInputId}' are duplicated.`);
  for (const [sourceInputId, rows] of visibleByInput) if (rows.length !== 1) throw new Error(`Responses visible projections for input '${sourceInputId}' are duplicated.`);
  for (const visible of [...visibleByInput.values()].flat()) {
    const marker = visible.provider_projection;
    if (!marker) throw new Error('unreachable');
    const privateEntry = privateById.get(marker.private_message_id);
    if (!privateEntry) throw new Error(`Responses visible projection '${visible.id}' is missing private row '${marker.private_message_id}'.`);
    if (privateEntry.content.source_input_id !== marker.source_input_id) throw new Error(`Responses projection '${visible.id}' has mismatched source_input_id.`);
    if (privateEntry.content.projection_message_id !== visible.id) throw new Error(`Responses projection '${visible.id}' is not referenced by private row '${marker.private_message_id}'.`);
  }
  for (const [privateId, entry] of privateById) {
    const projection = messages.find((message) => message.id === entry.content.projection_message_id && message.provider_projection?.private_message_id === privateId);
    if (!projection) throw new Error(`Responses private row '${privateId}' is missing marked visible projection '${entry.content.projection_message_id}'.`);
  }
}

function isFunctionCallItem(item: unknown): item is { type: 'function_call'; call_id: string } {
  return item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'function_call' && typeof (item as { call_id?: unknown }).call_id === 'string';
}

function toolPairKey(sourceInputId: string, callId: string): string {
  return `${sourceInputId}\u0000${callId}`;
}
