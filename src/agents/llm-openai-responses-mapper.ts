import type { AgentMessage } from '../schemas/index.js';
import {
  parsePrivateContent,
  validateResponsesPairs,
  parseToolCallMessageForModel,
  type ProviderConversationProjection,
} from '../contracts/index.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolResultMessageId } from '../schemas/message-identity.js';

type ResponsesInputItem = Record<string, unknown>;

export function responsesInputFromProviderConversation(providerConversation: ProviderConversationProjection): ResponsesInputItem[] {
  const canonicalRows: AgentMessage[] = [];
  for (const message of providerConversation.messages) {
    if (message.kind !== 'synthetic_context') canonicalRows.push(message);
  }
  const sourceSessionId = providerConversation.sourceSessionId;
  if (sourceSessionId !== null) validateResponsesPairs(sourceSessionId, canonicalRows);
  const input: ResponsesInputItem[] = [];
  const privateByProjection = new Map<string, ReturnType<typeof parsePrivateContent>>();
  for (const message of providerConversation.messages) {
    if (message.kind === 'synthetic_context') continue;
    if (message.kind === 'provider_private') {
      const row = parsePrivateContent(message);
      privateByProjection.set(row.projection_message_id, row);
    }
  }
  const emittedFunctionCalls = new Map<string, { sourceInputId: string; callId: string }>();
  const settled = new Set<string>();
  for (const message of providerConversation.messages) {
    if (message.kind === 'synthetic_context') {
      input.push(textInput(message.role, message.content));
      continue;
    }
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
    if (message.kind === 'text' || message.kind === 'model_repair') {
      if (message.role === 'tool') throw new Error(`Responses text row '${message.id}' cannot use the tool role.`);
      input.push(textInput(message.role, message.content));
      continue;
    }
    throw new Error(`Unsupported Responses replay row kind '${message.kind}' for '${message.id}'.`);
  }
  for (const { sourceInputId, callId } of emittedFunctionCalls.values()) {
    const key = toolPairKey(sourceInputId, callId);
    if (!settled.has(key)) throw new Error(`Responses replay contains unpaired function_call '${callId}' for input '${sourceInputId}'.`);
  }
  return input;
}

function textInput(role: 'system' | 'user' | 'assistant', content: string): ResponsesInputItem {
  return { role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }] };
}

function isFunctionCallItem(item: unknown): item is { type: 'function_call'; call_id: string } {
  return item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'function_call' && typeof (item as { call_id?: unknown }).call_id === 'string';
}

function toolPairKey(sourceInputId: string, callId: string): string {
  return `${sourceInputId}\u0000${callId}`;
}
