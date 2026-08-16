import type { LlmCompleteResult, ToolCall } from './llm-contracts.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { LlmRequestError } from '../contracts/llm-failure.js';
import { classifyDirectProviderFailure, parseFiniteRetryAfterMs } from './llm-failure-classifiers.js';
import { IncrementalSseReader, SSE_DONE, type SseOutput } from './llm-sse.js';

export async function readOpenAICodexStream(body: ReadableStream<Uint8Array>, responseStatus: number): Promise<LlmCompleteResult> {
  const reader = body.getReader();
  const sse = new IncrementalSseReader();
  let content = '';
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();
  const finalizedToolCalls = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const appendContent = (delta: string): void => {
    if (content.length > 0 && delta.startsWith(content)) content = delta;
    else if (!content.endsWith(delta)) content += delta;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        consumeCodexEvents(sse.finish(), responseStatus, pendingToolCalls, finalizedToolCalls, toolCalls, appendContent);
        break;
      }
      consumeCodexEvents(sse.push(value), responseStatus, pendingToolCalls, finalizedToolCalls, toolCalls, appendContent);
    }

    if (toolCalls.length > 0) return { kind: 'tool_calls', tool_calls: toolCalls };
    return { kind: 'message', content };
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new LlmRequestError({ kind: 'cancelled', provider: 'openai-codex', reason: 'timeout', message: 'OpenAI Codex streaming request aborted due to timeout' });
    }
    throw new LlmRequestError({ kind: 'parse_error', provider: 'openai-codex', message: `Error reading OpenAI Codex stream: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    reader.releaseLock();
  }
}

function consumeCodexEvents(outputs: SseOutput[], responseStatus: number, pendingToolCalls: Map<string, { id: string; name: string; args: string }>, finalizedToolCalls: Set<string>, toolCalls: ToolCall[], appendContent: (delta: string) => void): void {
  for (const output of outputs) if (output !== SSE_DONE) handleOpenAICodexEvent(output.dataText, responseStatus, pendingToolCalls, finalizedToolCalls, toolCalls, appendContent);
}

export function handleOpenAICodexEvent(
  dataText: string,
  responseStatus: number,
  pendingToolCalls: Map<string, { id: string; name: string; args: string }>,
  finalizedToolCalls: Set<string>,
  toolCalls: ToolCall[],
  appendContent: (delta: string) => void,
): void {
  const event = JSON.parse(dataText) as Record<string, unknown>;

  const type = event['type'];
  if (type === 'response.output_text.delta') {
    appendContent(String(event['delta'] ?? ''));
  } else if (type === 'response.output_item.added') {
    const item = event['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] === 'function_call') {
      const callId = String(item['call_id'] ?? item['id'] ?? `call_${pendingToolCalls.size}`);
      const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
      const pending = { id: callId, name: String(item['name'] ?? ''), args: String(item['arguments'] ?? '') };
      pendingToolCalls.set(callId, pending);
      if (itemId && itemId !== callId) pendingToolCalls.set(itemId, pending);
    }
  } else if (type === 'response.output_item.done') {
    const item = event['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] === 'function_call') {
      const callId = String(item['call_id'] ?? item['id'] ?? `call_${toolCalls.length}`);
      const itemId = typeof item['id'] === 'string' ? item['id'] : undefined;
      const pending = pendingToolCalls.get(callId) ?? (itemId ? pendingToolCalls.get(itemId) : undefined);
      finalizeCodexToolCall(toolCalls, finalizedToolCalls, callId, String(item['name'] ?? pending?.name ?? ''), String(item['arguments'] ?? pending?.args ?? '{}'));
      pendingToolCalls.delete(callId);
      if (itemId) pendingToolCalls.delete(itemId);
    } else if (item?.['type'] === 'message') {
      appendCodexMessageContent(item, appendContent);
    }
  } else if (type === 'response.content_part.done') {
    const part = event['part'] as Record<string, unknown> | undefined;
    if (part?.['type'] === 'output_text' && typeof part['text'] === 'string') appendContent(part['text']);
  } else if (type === 'response.output_text.done') {
    if (typeof event['text'] === 'string') appendContent(event['text']);
  } else if (type === 'response.function_call_arguments.delta') {
    const id = String(event['call_id'] ?? event['item_id'] ?? '');
    const pending = pendingToolCalls.get(id);
    if (pending) pending.args += String(event['delta'] ?? '');
  } else if (type === 'response.function_call_arguments.done') {
    const id = String(event['call_id'] ?? event['item_id'] ?? '');
    const pending = pendingToolCalls.get(id);
    const callId = String(event['call_id'] ?? pending?.id ?? id);
    if (pending || typeof event['arguments'] === 'string') {
      finalizeCodexToolCall(toolCalls, finalizedToolCalls, callId, String((event['name'] as string | undefined) ?? pending?.name ?? ''), String((event['arguments'] as string | undefined) ?? pending?.args ?? '{}'));
      pendingToolCalls.delete(id);
      if (pending?.id) pendingToolCalls.delete(pending.id);
    }
  } else if (type === 'response.failed') {
    throw createCodexStreamError('OpenAI Codex response failed', event, responseStatus, dataText);
  } else if (type === 'error') {
    throw createCodexStreamError('OpenAI Codex stream error', event, responseStatus, dataText);
  }
}

function finalizeCodexToolCall(
  toolCalls: ToolCall[],
  finalizedToolCalls: Set<string>,
  id: string,
  name: string,
  args: string,
): void {
  if (finalizedToolCalls.has(id)) return;
  finalizedToolCalls.add(id);
  toolCalls.push({ id, type: 'function', function: { name, arguments: args || '{}' } });
}

function appendCodexMessageContent(item: Record<string, unknown>, appendContent: (delta: string) => void): void {
  const content = item['content'];
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const typedPart = part as Record<string, unknown>;
    if (typedPart['type'] === 'output_text' && typeof typedPart['text'] === 'string') appendContent(typedPart['text']);
  }
}

function createCodexStreamError(prefix: string, payload: Record<string, unknown>, responseStatus: number, providerResponse: string): LlmRequestError {
  const error = codexDirectError(payload) ?? payload;
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const rawMessage = String(error['message'] ?? payload['message'] ?? JSON.stringify(payload));
  const codePrefix = code ? `${code}: ` : '';
  const message = `${prefix}: ${codePrefix}${redactTextForOutbound(rawMessage)}`;
  const embeddedStatus = statusFromCodexPayload(payload, error);
  const retryAfterMs = retryAfterMsFromCodexPayload(payload, error);
  const classified = classifyDirectProviderFailure({ provider: 'openai-codex', status: embeddedStatus, responseStatus, error, allowedContextParams: ['input'], message, providerResponse, retryAfterMs });
  if (classified) return new LlmRequestError(classified);
  return new LlmRequestError({ kind: 'provider_protocol_error', provider: 'openai-codex', status: responseStatus, message, bodyPreview: JSON.stringify(payload).slice(0, 500) });
}

function codexDirectError(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (payload['type'] === 'error') return directObject(payload['error']);
  if (payload['type'] !== 'response.failed') return undefined;
  const response = directObject(payload['response']);
  if (response?.['status'] !== 'failed') return undefined;
  return directObject(response['error']);
}

function directObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function statusFromCodexPayload(...payloads: Record<string, unknown>[]): number | undefined {
  for (const payload of payloads) {
    for (const key of ['status', 'response_status', 'http_status']) {
      const value = payload[key];
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
    const response = payload['response'];
    if (response && typeof response === 'object') {
      const status = statusFromCodexPayload(response as Record<string, unknown>);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

function retryAfterMsFromCodexPayload(...payloads: Record<string, unknown>[]): number | undefined {
  for (const payload of payloads) {
    const ms = payload['retry_after_ms'];
    const parsedMs = parseFiniteRetryAfterMs(ms, 1);
    if (parsedMs !== undefined) return parsedMs;
    const seconds = payload['retry_after'];
    const parsedSeconds = parseFiniteRetryAfterMs(seconds, 1000);
    if (parsedSeconds !== undefined) return parsedSeconds;
  }
  return undefined;
}
