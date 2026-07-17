import type { LlmCompleteResult, ToolCall } from './llm-contracts.js';
import { LlmRequestError, redactProviderErrorText } from './llm-errors.js';
import { isInputContextErrorObject } from './llm-failure-classifiers.js';

export async function readOpenAICodexStream(body: ReadableStream<Uint8Array>, responseStatus: number): Promise<LlmCompleteResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();
  const finalizedToolCalls = new Set<string>();
  const toolCalls: ToolCall[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleOpenAICodexSseChunk(chunk, responseStatus, pendingToolCalls, finalizedToolCalls, toolCalls, (delta) => {
          if (content.length > 0 && delta.startsWith(content)) {
            content = delta;
          } else if (!content.endsWith(delta)) {
            content += delta;
          }
        }, (_reason) => { /* ignored */ });
        boundary = buffer.indexOf('\n\n');
      }
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

export function handleOpenAICodexSseChunk(
  chunk: string,
  responseStatus: number,
  pendingToolCalls: Map<string, { id: string; name: string; args: string }>,
  finalizedToolCalls: Set<string>,
  toolCalls: ToolCall[],
  appendContent: (delta: string) => void,
  setFinishReason: (reason: 'stop' | 'tool_calls' | 'length') => void,
): void {
  const dataLines = chunk
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());

  for (const data of dataLines) {
    if (!data || data === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

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
    } else if (type === 'response.completed' || type === 'response.done') {
      const response = event['response'] as Record<string, unknown> | undefined;
      if (response?.['status'] === 'incomplete') setFinishReason('length');
    } else if (type === 'response.failed') {
      throw createCodexStreamError('OpenAI Codex response failed', event, responseStatus);
    } else if (type === 'error') {
      throw createCodexStreamError('OpenAI Codex stream error', event, responseStatus);
    }
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

function createCodexStreamError(prefix: string, payload: Record<string, unknown>, responseStatus: number): LlmRequestError {
  const nested = payload['error'];
  const error = nested && typeof nested === 'object' ? nested as Record<string, unknown> : payload;
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const type = typeof error['type'] === 'string' ? error['type'] : '';
  const rawMessage = String(error['message'] ?? payload['message'] ?? JSON.stringify(payload));
  const codePrefix = code ? `${code}: ` : '';
  const message = `${prefix}: ${codePrefix}${redactProviderErrorText(rawMessage, 'llm-codex-parser')}`;
  const embeddedStatus = statusFromCodexPayload(payload, error);
  const retryAfterMs = retryAfterMsFromCodexPayload(payload, error);
  const evidence = [code, type, rawMessage].join(' ');
  const contextError = codexContextError(payload);
  if (contextError !== undefined && isInputContextErrorObject(contextError, ['input'])) {
    return new LlmRequestError({ kind: 'input_context_exhausted', provider: 'openai-codex', status: responseStatus, message });
  }
  if (embeddedStatus === 401 || embeddedStatus === 403 || /auth|account|permission|unauthorized|forbidden/i.test(evidence)) {
    return new LlmRequestError({ kind: 'auth_permanent', provider: 'openai-codex', status: responseStatus, message });
  }
  if (embeddedStatus === 429 || retryAfterMs !== undefined || /rate_limit|rate limit/i.test(evidence)) {
    return new LlmRequestError({ kind: 'rate_limit', provider: 'openai-codex', status: responseStatus, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if ((embeddedStatus !== undefined && [500, 502, 503, 504].includes(embeddedStatus)) || /server_error|internal_server_error|service_unavailable|temporarily_unavailable|overloaded/i.test(evidence)) {
    return new LlmRequestError({ kind: 'server_transient', provider: 'openai-codex', status: responseStatus, message });
  }
  return new LlmRequestError({ kind: 'provider_protocol_error', provider: 'openai-codex', status: responseStatus, message, bodyPreview: JSON.stringify(payload).slice(0, 500) });
}

function codexContextError(payload: Record<string, unknown>): Record<string, unknown> | undefined {
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
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
    const seconds = payload['retry_after'];
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return undefined;
}
