import { LlmRequestError } from '../contracts/llm-failure.js';
import type { LlmCompleteResult, LlmUsage, OpenAIResponsesPrivateContext, ToolCall } from './llm-contracts.js';
import { classifyDirectProviderFailure } from './llm-failure-classifiers.js';

export interface ParsedOpenAIResponsesCompletion {
  result: LlmCompleteResult;
  privateContext: OpenAIResponsesPrivateContext;
  assistantOutputIds: string[];
  responseStatus: string;
}

interface ParserContext { provider: string; model: string; sourceInputId: string; responseStatus: number }

const KNOWN_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress']);

export function parseOpenAIResponsesJson(text: string, ctx: ParserContext): ParsedOpenAIResponsesCompletion {
  let response: Record<string, unknown>;
  try {
    response = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: `Failed to parse OpenAI Responses payload: ${error instanceof Error ? error.message : String(error)}`, bodyPreview: text.slice(0, 500) });
  }
  return parseOpenAIResponsesObject(response, ctx, text);
}

export function parseOpenAIResponsesObject(response: Record<string, unknown>, ctx: ParserContext, providerResponse: string): ParsedOpenAIResponsesCompletion {
  const status = response.status;
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: 'OpenAI Responses payload has missing or unknown status.', bodyPreview: providerResponse.slice(0, 500) });
  if (status !== 'completed') throw nonCompletedFailure(response, ctx, status, providerResponse);
  const output = response.output;
  if (!Array.isArray(output)) throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: 'OpenAI Responses completed payload is missing output array.', bodyPreview: providerResponse.slice(0, 500) });

  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];
  const assistantOutputIds: string[] = [];
  for (const item of output) {
    if (item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') assistantOutputIds.push((item as { id: string }).id);
    if (isFunctionCall(item)) {
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      continue;
    }
    collectOutputText(item, textParts);
  }
  const usage = parseUsage(response.usage);
  const result: LlmCompleteResult = toolCalls.length > 0 ? { kind: 'tool_calls', tool_calls: toolCalls, usage } : { kind: 'message', content: textParts.join(''), usage };
  return {
    result,
    privateContext: { kind: 'openai_responses', source_input_id: ctx.sourceInputId, provider: ctx.provider, model: ctx.model, output },
    assistantOutputIds,
    responseStatus: status,
  };
}

function nonCompletedFailure(response: Record<string, unknown>, ctx: ParserContext, status: string, providerResponse: string): LlmRequestError {
  if (status === 'incomplete') {
    const reason = incompleteReason(response);
    if (ctx.responseStatus === 200 && reason === 'max_output_tokens') return new LlmRequestError({ kind: 'output_token_limit_exceeded', provider: ctx.provider, status: ctx.responseStatus, message: 'OpenAI Responses exceeded max_output_tokens.' });
    return new LlmRequestError({ kind: 'provider_protocol_error', provider: ctx.provider, status: ctx.responseStatus, message: `OpenAI Responses returned incomplete status${reason ? ` (${reason})` : ''}.`, bodyPreview: providerResponse.slice(0, 500) });
  }
  if (status === 'cancelled') return new LlmRequestError({ kind: 'server_transient', provider: ctx.provider, status: ctx.responseStatus, message: 'OpenAI Responses provider cancelled response before completion' });
  if (status === 'failed') {
    const error = objectField(response, 'error');
    const classified = classifyDirectProviderFailure({ provider: ctx.provider, responseStatus: ctx.responseStatus, error: ctx.responseStatus === 200 ? error : undefined, allowedContextParams: ['input'], message: providerErrorMessage(response), providerResponse });
    if (classified) return new LlmRequestError(classified);
    return new LlmRequestError({ kind: 'server_transient', provider: ctx.provider, status: ctx.responseStatus, message: providerErrorMessage(response) });
  }
  return new LlmRequestError({ kind: 'provider_protocol_error', provider: ctx.provider, status: ctx.responseStatus, message: `OpenAI Responses terminal parser received nonterminal status '${status}'.`, bodyPreview: providerResponse.slice(0, 500) });
}

function incompleteReason(response: Record<string, unknown>): string | undefined {
  const details = response.incomplete_details;
  return details !== null && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string' ? (details as { reason: string }).reason : undefined;
}

function providerErrorMessage(response: Record<string, unknown>): string {
  const error = response.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return `OpenAI Responses provider failed response before completion: ${message}`;
  }
  return 'OpenAI Responses provider failed response before completion';
}

function isFunctionCall(item: unknown): item is { type: 'function_call'; call_id: string; name: string; arguments: string } {
  return item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'function_call' && typeof (item as { call_id?: unknown }).call_id === 'string' && typeof (item as { name?: unknown }).name === 'string' && typeof (item as { arguments?: unknown }).arguments === 'string';
}

function collectOutputText(item: unknown, textParts: string[]): void {
  if (item === null || typeof item !== 'object') return;
  const typed = item as { type?: unknown; content?: unknown; text?: unknown };
  if (typed.type === 'output_text' && typeof typed.text === 'string') textParts.push(typed.text);
  if (Array.isArray(typed.content)) {
    for (const content of typed.content) {
      if (content !== null && typeof content === 'object' && (content as { type?: unknown }).type === 'output_text' && typeof (content as { text?: unknown }).text === 'string') textParts.push((content as { text: string }).text);
    }
  }
}

function parseUsage(usage: unknown): LlmUsage | undefined {
  if (usage === null || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  return {
    prompt_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
    completion_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
  };
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return field !== null && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}
