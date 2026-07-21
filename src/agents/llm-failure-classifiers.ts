import type { LlmTransportFailure } from '../contracts/llm-failure.js';
import { redactProviderErrorText } from './llm-errors.js';

export interface ClassifierContext {
  provider: string;
  model: string;
}

export type KnownProvider = 'openai-codex' | 'opencode-go' | 'openai-chat' | 'opencode' | 'github-copilot' | 'nvidia-nim';
export type LlmHttpTransport = 'chat' | 'responses' | 'codex';

function detail(bodyText: string): string {
  if (!bodyText) return '';
  return `: ${redactProviderErrorText(bodyText.slice(0, 500))}`;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function parseResetsAt(headers: Headers): string | undefined {
  const raw = headers.get('x-ratelimit-reset') ?? headers.get('x-ratelimit-reset-requests');
  if (!raw) return undefined;
  if (Number.isFinite(Date.parse(raw))) return raw;
  return undefined;
}

function bodyMatches(bodyText: string, fragment: string): boolean {
  return bodyText.toLowerCase().includes(fragment.toLowerCase());
}

export function classifyHttpFailure(
  transport: LlmHttpTransport,
  response: Response,
  bodyText: string,
  ctx: ClassifierContext,
): LlmTransportFailure {
  const status = response.status;
  const provider = ctx.provider;
  const d = detail(bodyText);

  if (status === 400) {
    const body = parseJsonObject(bodyText);
    const error = body === undefined ? undefined : directObject(body['error']);
    const allowedParams = transport === 'chat' ? ['input', 'messages'] : ['input'];
    if (error !== undefined && isInputContextErrorObject(error, allowedParams)) {
      return {
        kind: 'input_context_exhausted',
        provider,
        status,
        message: `LLM input context exhausted (HTTP ${status})${d}`,
      };
    }
  }

  if (status === 401 || status === 403) {
    return { kind: 'auth_permanent', provider, status, message: `LLM authentication failed (HTTP ${status})${d}` };
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers);
    const resetsAt = parseResetsAt(response.headers);
    const failure: LlmTransportFailure = { kind: 'rate_limit', provider, status, message: `LLM rate limit exceeded (HTTP 429)${d}` };
    if (retryAfterMs !== undefined) (failure as Extract<LlmTransportFailure, { kind: 'rate_limit' }>).retryAfterMs = retryAfterMs;
    if (resetsAt !== undefined) (failure as Extract<LlmTransportFailure, { kind: 'rate_limit' }>).resetsAt = resetsAt;
    return failure;
  }
  if (status >= 500) {
    return { kind: 'server_transient', provider, status, message: `LLM server error (HTTP ${status})${d}` };
  }
  if (status === 400 && bodyMatches(bodyText, 'usage_limit_reached')) {
    return { kind: 'rate_limit', provider, status: 429, message: `LLM usage limit reached (HTTP ${status})${d}` };
  }
  return {
    kind: 'provider_protocol_error',
    provider,
    status,
    message: `LLM provider protocol error (HTTP ${status})${d}`,
    bodyPreview: bodyText.slice(0, 500),
  };
}

export function isInputContextErrorObject(
  error: Record<string, unknown>,
  allowedParams: readonly string[],
): boolean {
  const code = error['code'];
  const type = error['type'];
  const markerMatches = code === 'context_length_exceeded'
    ? type === undefined || type === null || type === 'invalid_request_error' || type === 'context_length_exceeded'
    : (code === undefined || code === null) && type === 'context_length_exceeded';
  if (!markerMatches) return false;
  const param = error['param'];
  return param === undefined || param === null || (typeof param === 'string' && allowedParams.includes(param));
}

function parseJsonObject(bodyText: string): Record<string, unknown> | undefined {
  try {
    return directObject(JSON.parse(bodyText));
  } catch {
    return undefined;
  }
}

function directObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function defaultTransportClassifier(err: unknown, ctx: ClassifierContext): LlmTransportFailure | undefined {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { kind: 'cancelled', provider: ctx.provider, reason: 'abort', message: 'LLM request aborted' };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'cancelled', provider: ctx.provider, reason: 'abort', message: err.message || 'LLM request aborted' };
  }
  if (err instanceof Error) {
    const message = err.message;
    if (/ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT/i.test(message) || /timeout/i.test(message)) {
      return { kind: 'timeout', provider: ctx.provider, message };
    }
    const errnoCode = (err as Error & { code?: unknown }).code;
    if (typeof errnoCode === 'string' && /^(ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT)$/i.test(errnoCode)) {
      return { kind: 'timeout', provider: ctx.provider, message };
    }
  }
  return undefined;
}

export function classifyTransportFailure(err: unknown, ctx: ClassifierContext): LlmTransportFailure {
  return defaultTransportClassifier(err, ctx)
      ?? { kind: 'unknown', provider: ctx.provider, message: err instanceof Error ? err.message : String(err) };
}
