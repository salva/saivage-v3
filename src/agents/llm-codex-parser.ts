import {
  LlmRequestError,
  type LlmCompleteResult,
  type LlmUsage,
  type ToolCall,
} from '../contracts/index.js';
import { extractResponsesUsage } from './llm-usage.js';
import { redactTextForOutbound } from '../redaction/index.js';
import {
  classifyDirectProviderFailure,
  parseFiniteRetryAfterMs,
} from './llm-failure-classifiers.js';
import { IncrementalSseReader, SSE_DONE, type SseOutput } from './llm-sse.js';

type PendingCodexToolCall = { id: string; itemId?: string; name: unknown; args: string };

export async function readOpenAICodexStream(
  body: ReadableStream<Uint8Array>,
  responseStatus: number,
  signal?: AbortSignal,
  onData: () => void = () => {},
  suppressBodyPreview = false,
): Promise<LlmCompleteResult> {
  const reader = body.getReader();
  let naturalEOF = false;
  const sse = new IncrementalSseReader();
  let message: string | undefined;
  let usage: LlmUsage | undefined;
  const setUsage = (value: LlmUsage | undefined): void => {
    usage = value;
  };
  const pendingToolCalls = new Map<string, PendingCodexToolCall>();
  const finalizedToolCalls = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const setMessage = (content: string): void => {
    message = content;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        naturalEOF = true;
        if (
          consumeCodexEvents(
            sse.finish(),
            responseStatus,
            pendingToolCalls,
            finalizedToolCalls,
            toolCalls,
            setMessage,
            setUsage,
            onData,
            suppressBodyPreview,
          )
        ) {
          return completedCodexResult(toolCalls, message, usage);
        }
        throw new Error('OpenAI Codex stream truncated before response.completed.');
      }
      if (
        consumeCodexEvents(
          sse.push(value),
          responseStatus,
          pendingToolCalls,
          finalizedToolCalls,
          toolCalls,
          setMessage,
          setUsage,
          onData,
          suppressBodyPreview,
        )
      ) {
        return completedCodexResult(toolCalls, message, usage);
      }
    }
  } catch (err) {
    if (
      (signal?.aborted && err === signal.reason) ||
      ((err instanceof Error || err instanceof DOMException) && err.name === 'AbortError')
    )
      throw err;
    if (err instanceof LlmRequestError) throw err;
    throw new LlmRequestError({
      kind: 'parse_error',
      provider: 'openai-codex',
      message:
        suppressBodyPreview && err instanceof SyntaxError
          ? 'Error reading OpenAI Codex stream: invalid JSON payload.'
          : `Error reading OpenAI Codex stream: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    // Cancellation may never settle; cleanup must not replace the known result or failure.
    if (!naturalEOF) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function completedCodexResult(
  toolCalls: ToolCall[],
  message: string | undefined,
  usage: LlmUsage | undefined,
): LlmCompleteResult {
  const metadata = usage === undefined ? {} : { usage };
  if (toolCalls.length > 0) return { kind: 'tool_calls', tool_calls: toolCalls, ...metadata };
  if (message !== undefined) return { kind: 'message', content: message, ...metadata };
  throw new Error(
    'OpenAI Codex response completed without a finalized tool call or completed assistant message.',
  );
}

function consumeCodexEvents(
  outputs: SseOutput[],
  responseStatus: number,
  pendingToolCalls: Map<string, PendingCodexToolCall>,
  finalizedToolCalls: Set<string>,
  toolCalls: ToolCall[],
  setMessage: (content: string) => void,
  setUsage: (usage: LlmUsage | undefined) => void,
  onData: () => void,
  suppressBodyPreview: boolean,
): boolean {
  for (const output of outputs) {
    onData();
    if (output === SSE_DONE)
      throw new Error('OpenAI Codex stream ended before response.completed.');
    if (
      handleOpenAICodexEvent(
        output.dataText,
        responseStatus,
        pendingToolCalls,
        finalizedToolCalls,
        toolCalls,
        setMessage,
        setUsage,
        suppressBodyPreview,
      )
    )
      return true;
  }
  return false;
}

export function handleOpenAICodexEvent(
  dataText: string,
  responseStatus: number,
  pendingToolCalls: Map<string, PendingCodexToolCall>,
  finalizedToolCalls: Set<string>,
  toolCalls: ToolCall[],
  setMessage: (content: string) => void,
  setUsage: (usage: LlmUsage | undefined) => void,
  suppressBodyPreview = false,
): boolean {
  const event = JSON.parse(dataText) as Record<string, unknown>;

  const type = event['type'];
  if (type === 'response.output_text.delta') {
    if (typeof event['delta'] !== 'string')
      throw new Error('OpenAI Codex output text delta must be a string.');
  } else if (type === 'response.output_item.added') {
    const item = event['item'] as Record<string, unknown> | undefined;
    if (item?.['type'] === 'function_call') {
      const callId = realCodexIdentity(item, 'id');
      const itemId = optionalCodexItemIdentity(item);
      const pending = {
        id: callId,
        itemId,
        name: item['name'],
        args: String(item['arguments'] ?? ''),
      };
      pendingToolCalls.set(callId, pending);
      if (itemId && itemId !== callId) pendingToolCalls.set(itemId, pending);
    }
  } else if (type === 'response.output_item.done') {
    const item = directObject(event['item']);
    if (!item) throw new Error('OpenAI Codex completed output item must be an object.');
    if (item['type'] === 'function_call') {
      const callId = realCodexIdentity(item, 'id');
      const itemId = optionalCodexItemIdentity(item);
      const pending =
        pendingToolCalls.get(callId) ?? (itemId ? pendingToolCalls.get(itemId) : undefined);
      finalizeCodexToolCall(
        toolCalls,
        finalizedToolCalls,
        pending?.id ?? callId,
        item['name'] ?? pending?.name,
        String(item['arguments'] ?? pending?.args ?? '{}'),
      );
      if (pending) removePendingCodexToolCall(pendingToolCalls, pending);
    } else if (item['type'] === 'message') {
      setMessage(completedCodexMessageContent(item));
    }
  } else if (type === 'response.function_call_arguments.delta') {
    const id = realCodexIdentity(event, 'item_id');
    const pending = pendingToolCalls.get(id);
    if (!pending)
      throw new Error(`OpenAI Codex argument delta targets unknown function call '${id}'.`);
    if (typeof event['delta'] !== 'string')
      throw new Error('OpenAI Codex argument delta must be a string.');
    pending.args += event['delta'];
  } else if (type === 'response.function_call_arguments.done') {
    const id = realCodexIdentity(event, 'item_id');
    const pending = pendingToolCalls.get(id);
    if (!pending)
      throw new Error(`OpenAI Codex completed arguments target unknown function call '${id}'.`);
    finalizeCodexToolCall(
      toolCalls,
      finalizedToolCalls,
      pending.id,
      event['name'] ?? pending.name,
      String(event['arguments'] ?? pending.args),
    );
    removePendingCodexToolCall(pendingToolCalls, pending);
  } else if (type === 'response.failed') {
    throw createCodexStreamError(
      'OpenAI Codex response failed',
      event,
      responseStatus,
      dataText,
      suppressBodyPreview,
    );
  } else if (type === 'error') {
    throw createCodexStreamError(
      'OpenAI Codex stream error',
      event,
      responseStatus,
      dataText,
      suppressBodyPreview,
    );
  } else if (type === 'response.completed') {
    const response = directObject(event['response']);
    if (!response || typeof response['id'] !== 'string') {
      throw new Error(
        'OpenAI Codex response.completed must carry an object response with a string id.',
      );
    }
    setUsage(extractResponsesUsage(response['usage'], 'openai-codex'));
    return true;
  }
  return false;
}

function realCodexIdentity(value: Record<string, unknown>, fallbackKey: 'id' | 'item_id'): string {
  const selected = value['call_id'] === undefined ? value[fallbackKey] : value['call_id'];
  if (typeof selected !== 'string' || selected.length === 0)
    throw new Error('OpenAI Codex function call must carry a nonempty real identity.');
  return selected;
}

function optionalCodexItemIdentity(item: Record<string, unknown>): string | undefined {
  const id = item['id'];
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('OpenAI Codex function item id must be a nonempty string.');
  return id;
}

function removePendingCodexToolCall(
  pendingToolCalls: Map<string, PendingCodexToolCall>,
  pending: PendingCodexToolCall,
): void {
  pendingToolCalls.delete(pending.id);
  if (pending.itemId) pendingToolCalls.delete(pending.itemId);
}

function finalizeCodexToolCall(
  toolCalls: ToolCall[],
  finalizedToolCalls: Set<string>,
  id: string,
  name: unknown,
  args: string,
): void {
  if (finalizedToolCalls.has(id)) return;
  if (typeof name !== 'string' || name.length === 0)
    throw new Error('OpenAI Codex finalized function name must be a nonempty string.');
  finalizedToolCalls.add(id);
  toolCalls.push({ id, type: 'function', function: { name, arguments: args || '{}' } });
}

function completedCodexMessageContent(item: Record<string, unknown>): string {
  if (item['role'] !== 'assistant')
    throw new Error('OpenAI Codex completed message role must be assistant.');
  const content = item['content'];
  if (!Array.isArray(content))
    throw new Error('OpenAI Codex completed message content must be an array.');
  let message = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const typedPart = part as Record<string, unknown>;
    if (typedPart['type'] !== 'output_text') continue;
    if (typeof typedPart['text'] !== 'string')
      throw new Error('OpenAI Codex completed output text must be a string.');
    message += typedPart['text'];
  }
  return message;
}

function createCodexStreamError(
  prefix: string,
  payload: Record<string, unknown>,
  responseStatus: number,
  providerResponse: string,
  suppressBodyPreview: boolean,
): LlmRequestError {
  const error = codexDirectError(payload) ?? payload;
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const rawMessage = String(error['message'] ?? payload['message'] ?? JSON.stringify(payload));
  const codePrefix = code ? `${code}: ` : '';
  const message = suppressBodyPreview
    ? `${prefix} (provider diagnostics omitted for image input).`
    : `${prefix}: ${codePrefix}${redactTextForOutbound(rawMessage)}`;
  const embeddedStatus = statusFromCodexPayload(payload, error);
  const retryAfterMs = retryAfterMsFromCodexPayload(payload, error);
  const classified = classifyDirectProviderFailure({
    provider: 'openai-codex',
    source: { kind: 'opened_response_terminal', responseStatus, embeddedStatus },
    error,
    allowedContextParams: ['input'],
    message,
    providerResponse: suppressBodyPreview ? '' : providerResponse,
    retryAfterMs,
  });
  if (classified) return new LlmRequestError(classified);
  return new LlmRequestError({
    kind: 'provider_protocol_error',
    provider: 'openai-codex',
    status: responseStatus,
    message,
    bodyPreview: suppressBodyPreview ? '' : JSON.stringify(payload).slice(0, 500),
  });
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
    ? (value as Record<string, unknown>)
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
