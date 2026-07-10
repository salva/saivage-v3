import { LlmRequestError } from './llm-errors.js';
import type { LlmCompleteResult, LlmUsage, OpenAIResponsesPrivateContext, ToolCall } from './llm-contracts.js';

export interface ParsedOpenAIResponsesCompletion {
  result: LlmCompleteResult;
  privateContext: OpenAIResponsesPrivateContext;
  assistantOutputIds: string[];
  responseStatus: string;
}

interface ParserContext { provider: string; model: string; sourceInputId: string }

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

export function parseOpenAIResponsesObject(response: Record<string, unknown>, ctx: ParserContext, bodyPreview = ''): ParsedOpenAIResponsesCompletion {
  const status = response.status;
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: 'OpenAI Responses payload has missing or unknown status.', bodyPreview: bodyPreview.slice(0, 500) });
  if (status !== 'completed') throw nonCompletedFailure(response, ctx, status, bodyPreview);
  const output = response.output;
  if (!Array.isArray(output)) throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: 'OpenAI Responses completed payload is missing output array.', bodyPreview: bodyPreview.slice(0, 500) });

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

export async function readOpenAIResponsesStream(stream: ReadableStream<Uint8Array>, ctx: ParserContext): Promise<ParsedOpenAIResponsesCompletion> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: Record<string, unknown> | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseFrame(frame, ctx.provider);
      if (!parsed) continue;
      if (parsed.event === 'response.completed' || parsed.event === 'response.incomplete' || parsed.event === 'response.failed' || parsed.event === 'response.cancelled') finalResponse = parsed.data;
      if (parsed.data && Array.isArray(parsed.data.output) && typeof parsed.data.status === 'string') finalResponse = parsed.data;
      if (parsed.data && parsed.data.response && typeof parsed.data.response === 'object') {
        const response = parsed.data.response as Record<string, unknown>;
        if (Array.isArray(response.output) && typeof response.status === 'string') finalResponse = response;
      }
    }
  }
  if (!finalResponse) throw new LlmRequestError({ kind: 'parse_error', provider: ctx.provider, message: 'OpenAI Responses stream ended before a terminal response payload.' });
  return parseOpenAIResponsesObject(finalResponse, ctx);
}

function nonCompletedFailure(response: Record<string, unknown>, ctx: ParserContext, status: string, bodyPreview: string): LlmRequestError {
  if (status === 'incomplete') {
    const reason = incompleteReason(response);
    if (reason === 'max_output_tokens') return new LlmRequestError({ kind: 'token_budget_exceeded', provider: ctx.provider, status: 200, message: 'OpenAI Responses exceeded max_output_tokens.' });
    return new LlmRequestError({ kind: 'provider_protocol_error', provider: ctx.provider, status: 200, message: `OpenAI Responses returned incomplete status${reason ? ` (${reason})` : ''}.`, bodyPreview: bodyPreview.slice(0, 500) });
  }
  if (status === 'cancelled') return new LlmRequestError({ kind: 'server_transient', provider: ctx.provider, status: 200, message: 'OpenAI Responses provider cancelled response before completion' });
  if (status === 'failed') return new LlmRequestError({ kind: 'server_transient', provider: ctx.provider, status: 200, message: providerErrorMessage(response) });
  return new LlmRequestError({ kind: 'provider_protocol_error', provider: ctx.provider, status: 200, message: `OpenAI Responses terminal parser received nonterminal status '${status}'.`, bodyPreview: bodyPreview.slice(0, 500) });
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

function parseSseFrame(frame: string, provider: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join('\n');
  if (dataText === '[DONE]') return null;
  try {
    return { event, data: JSON.parse(dataText) as Record<string, unknown> };
  } catch (error) {
    throw new LlmRequestError({ kind: 'parse_error', provider, message: `OpenAI Responses stream frame has invalid JSON: ${error instanceof Error ? error.message : String(error)}`, bodyPreview: dataText.slice(0, 500) });
  }
}
