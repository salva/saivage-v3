import type { LlmTransportFailure } from '../contracts/llm-failure.js';
import { redactTextForOutbound } from '../redaction/index.js';

export interface ClassifierContext {
  provider: string;
  model: string;
}

export type LlmHttpTransport = 'chat' | 'responses' | 'codex';

export function parseFiniteRetryAfterMs(value: unknown, millisecondsPerUnit: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const milliseconds = Math.round(value * millisecondsPerUnit);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function detail(bodyText: string): string {
  if (!bodyText) return '';
  return `: ${redactTextForOutbound(bodyText.slice(0, 500))}`;
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  const numericMilliseconds = parseFiniteRetryAfterMs(seconds, 1000);
  if (numericMilliseconds !== undefined) return numericMilliseconds;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export function parseResetsAt(headers: Headers): string | undefined {
  const raw = headers.get('x-ratelimit-reset') ?? headers.get('x-ratelimit-reset-requests');
  if (!raw) return undefined;
  if (Number.isFinite(Date.parse(raw))) return raw;
  return undefined;
}

const CONTENT_POLICY_TOKENS = new Set(['cyber_policy', 'content_filter']);
const CONTENT_POLICY_PHRASES = ['content policy', 'safety policy', 'safety refusal', 'request was blocked for safety', 'cannot assist with this request'];
const RATE_LIMIT_TOKENS = new Set(['rate_limit', 'rate_limit_exceeded', 'usage_limit_reached']);
const TRANSIENT_TOKENS = new Set(['server_error', 'internal_server_error', 'service_unavailable', 'temporarily_unavailable', 'overloaded', 'server_is_overloaded']);
const AUTH_TOKENS = new Set(['auth', 'authentication_error', 'unauthorized', 'forbidden', 'permission_denied']);

function directText(error: Record<string, unknown>, key: 'code' | 'type' | 'message'): string | undefined {
  const value = error[key];
  return typeof value === 'string' ? value : undefined;
}

function directToken(error: Record<string, unknown>, tokens: ReadonlySet<string>): boolean {
  return [directText(error, 'code'), directText(error, 'type')].some((value) => value !== undefined && tokens.has(value.toLowerCase()));
}

export function hasContentPolicyEvidence(error: Record<string, unknown>): boolean {
  if (directToken(error, CONTENT_POLICY_TOKENS)) return true;
  const message = directText(error, 'message')?.toLowerCase();
  return message !== undefined && CONTENT_POLICY_PHRASES.some((phrase) => message.includes(phrase));
}

export type DirectProviderFailureSource =
  | { kind: 'non_ok_http_response'; responseStatus: number }
  | {
      kind: 'opened_response_terminal';
      responseStatus: number;
      embeddedStatus: number | undefined;
    };

export function classifyDirectProviderFailure(args: {
  provider: string;
  source: DirectProviderFailureSource;
  error?: Record<string, unknown>;
  allowedContextParams: readonly string[];
  message: string;
  providerResponse: string;
  retryAfterMs?: number;
  resetsAt?: string;
}): LlmTransportFailure | undefined {
  const { provider, error, source } = args;
  const responseStatus = source.responseStatus;
  const embeddedStatus = source.kind === 'opened_response_terminal' ? source.embeddedStatus : undefined;
  if (responseStatus === 401 || embeddedStatus === 401) return { kind: 'auth_permanent', provider, status: responseStatus, message: args.message };
  if (responseStatus === 429 || embeddedStatus === 429 || args.retryAfterMs !== undefined || args.resetsAt !== undefined || (error !== undefined && directToken(error, RATE_LIMIT_TOKENS))) {
    return { kind: 'rate_limit', provider, status: responseStatus, message: args.message, ...(args.retryAfterMs !== undefined ? { retryAfterMs: args.retryAfterMs } : {}), ...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}) };
  }
  if ((embeddedStatus !== undefined && embeddedStatus >= 500) || responseStatus >= 500 || (error !== undefined && directToken(error, TRANSIENT_TOKENS))) return { kind: 'server_transient', provider, status: responseStatus, message: args.message };
  const contextEligible = source.kind === 'opened_response_terminal' || responseStatus === 400;
  const context = contextEligible && error !== undefined && isInputContextErrorObject(error, args.allowedContextParams);
  const content = error !== undefined && hasContentPolicyEvidence(error);
  if (context && content) return { kind: 'provider_protocol_error', provider, status: responseStatus, message: `Ambiguous provider failure contains both input-context and content-policy evidence.`, bodyPreview: args.providerResponse.slice(0, 500) };
  if (context) return { kind: 'input_context_exhausted', provider, status: responseStatus, message: args.message };
  if (content) return { kind: 'content_policy', provider, status: responseStatus, message: args.message, providerResponse: args.providerResponse };
  if (responseStatus === 403 || embeddedStatus === 403 || (error !== undefined && directToken(error, AUTH_TOKENS))) return { kind: 'auth_permanent', provider, status: responseStatus, message: args.message };
  return undefined;
}

export function classifyHttpFailure(
  transport: LlmHttpTransport,
  response: Response,
  bodyText: string,
  ctx: ClassifierContext,
): LlmTransportFailure {
  if (response.ok) throw new Error('classifyHttpFailure requires a non-OK HTTP response.');
  const status = response.status;
  const provider = ctx.provider;
  const d = detail(bodyText);
  const body = parseJsonObject(bodyText);
  const error = body === undefined ? undefined : directObject(body['error']);
  const classified = classifyDirectProviderFailure({
    provider,
    source: { kind: 'non_ok_http_response', responseStatus: status },
    error,
    allowedContextParams: transport === 'chat' ? ['input', 'messages'] : ['input'],
    message: `LLM request failed (HTTP ${status})${d}`,
    providerResponse: bodyText,
    retryAfterMs: parseRetryAfterMs(response.headers),
    resetsAt: parseResetsAt(response.headers),
  });
  if (classified) return classified;
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
