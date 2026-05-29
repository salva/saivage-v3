import type { LlmFailure } from './llm-failure.js';
import { redactProviderErrorText } from './llm-errors.js';

export interface ClassifierContext {
  provider: string;
  model: string;
}

export interface ProviderFailureClassifier {
  classifyHttp(response: Response, bodyText: string, ctx: ClassifierContext): LlmFailure | undefined;
  classifyTransport(err: unknown, ctx: ClassifierContext): LlmFailure | undefined;
}

const KNOWN_PROVIDERS = ['openai-codex', 'opencode-go', 'openai-chat', 'opencode', 'github-copilot', 'nvidia-nim'] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

function detail(bodyText: string, source: string): string {
  if (!bodyText) return '';
  return `: ${redactProviderErrorText(bodyText.slice(0, 500), source)}`;
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

export function defaultHttpClassifier(response: Response, bodyText: string, ctx: ClassifierContext): LlmFailure {
  const status = response.status;
  const provider = ctx.provider;
  const source = `llm-${provider}`;
  const d = detail(bodyText, source);

  if (status === 401 || status === 403) {
    return { kind: 'auth_permanent', provider, status, message: `LLM authentication failed (HTTP ${status})${d}` };
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers);
    const resetsAt = parseResetsAt(response.headers);
    const failure: LlmFailure = { kind: 'rate_limit', provider, status, message: `LLM rate limit exceeded (HTTP 429)${d}` };
    if (retryAfterMs !== undefined) (failure as Extract<LlmFailure, { kind: 'rate_limit' }>).retryAfterMs = retryAfterMs;
    if (resetsAt !== undefined) (failure as Extract<LlmFailure, { kind: 'rate_limit' }>).resetsAt = resetsAt;
    return failure;
  }
  if (status === 400 && bodyMatches(bodyText, 'context_length_exceeded')) {
    return { kind: 'token_budget_exceeded', provider, status, message: `LLM token budget exceeded (HTTP ${status})${d}` };
  }
  if (status >= 500) {
    return { kind: 'server_transient', provider, status, message: `LLM server error (HTTP ${status})${d}` };
  }
  if (status === 400 && bodyMatches(bodyText, 'usage_limit_reached')) {
    return { kind: 'rate_limit', provider, status: 429, message: `LLM usage limit reached (HTTP ${status})${d}` };
  }
  return { kind: 'server_transient', provider, status, message: `LLM request failed (HTTP ${status})${d}` };
}

function defaultTransportClassifier(err: unknown, ctx: ClassifierContext): LlmFailure | undefined {
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

const OPENCODE_GO_CONTRACT_FRAGMENTS = [
  'You cannot specify response format and function call at the same time',
];

const OpenCodeGoClassifier: ProviderFailureClassifier = {
  classifyHttp(response, bodyText, ctx) {
    if (response.status === 400) {
      for (const fragment of OPENCODE_GO_CONTRACT_FRAGMENTS) {
        if (bodyMatches(bodyText, fragment)) {
          return {
            kind: 'contract_mismatch',
            provider: ctx.provider,
            subtype: 'unknown',
            status: 400,
            message: `LLM contract mismatch (HTTP 400)${detail(bodyText, `llm-${ctx.provider}`)}`,
          };
        }
      }
      // Any other HTTP 400 from opencode-go is also a contract violation per F08 plan.
      return {
        kind: 'contract_mismatch',
        provider: ctx.provider,
        subtype: 'unknown',
        status: 400,
        message: `LLM contract mismatch (HTTP 400)${detail(bodyText, `llm-${ctx.provider}`)}`,
      };
    }
    return undefined;
  },
  classifyTransport(err, ctx) {
    return defaultTransportClassifier(err, ctx);
  },
};

const PassthroughClassifier: ProviderFailureClassifier = {
  classifyHttp() { return undefined; },
  classifyTransport(err, ctx) { return defaultTransportClassifier(err, ctx); },
};

const CLASSIFIERS: Record<string, ProviderFailureClassifier> = {
  'opencode-go': OpenCodeGoClassifier,
  'openai-codex': PassthroughClassifier,
  'openai-chat': PassthroughClassifier,
  'opencode': PassthroughClassifier,
  'github-copilot': PassthroughClassifier,
  'nvidia-nim': PassthroughClassifier,
};

export function classifierFor(provider: string): ProviderFailureClassifier {
  return CLASSIFIERS[provider] ?? PassthroughClassifier;
}

export function classifyTransportFailure(err: unknown, ctx: ClassifierContext): LlmFailure {
  return classifierFor(ctx.provider).classifyTransport(err, ctx)
      ?? defaultTransportClassifier(err, ctx)
      ?? { kind: 'unknown', provider: ctx.provider, message: err instanceof Error ? err.message : String(err) };
}
