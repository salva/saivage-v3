import { redactTextForOutbound } from '../redaction/index.js';

export class LlmAuthError extends Error {
  public readonly code: string = 'LLM_AUTH_ERROR';
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = 'LlmAuthError';
    this.statusCode = statusCode;
  }
}

export class LlmRateLimitError extends Error {
  public readonly code: string = 'LLM_RATE_LIMIT_ERROR';
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 429) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.statusCode = statusCode;
  }
}

export class LlmServerError extends Error {
  public readonly code: string = 'LLM_SERVER_ERROR';
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'LlmServerError';
    this.statusCode = statusCode;
  }
}

export class LlmTimeoutError extends Error {
  public readonly code: string = 'LLM_TIMEOUT_ERROR';

  constructor(message: string = 'LLM request timed out') {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmParseError extends Error {
  public readonly code: string = 'LLM_PARSE_ERROR';
  public readonly responseBody: string;

  constructor(message: string, responseBody: string) {
    super(message);
    this.name = 'LlmParseError';
    this.responseBody = responseBody;
  }
}

export type StructuredLlmError = LlmAuthError | LlmRateLimitError | LlmServerError | LlmTimeoutError | LlmParseError;

export function isStructuredLlmError(err: unknown): err is StructuredLlmError {
  return err instanceof LlmAuthError
    || err instanceof LlmRateLimitError
    || err instanceof LlmServerError
    || err instanceof LlmTimeoutError
    || err instanceof LlmParseError;
}

export function redactProviderErrorText(text: string, source: string = 'llm-provider-gateway'): string {
  return redactTextForOutbound(text, 'provider.diagnostic', { source });
}

export async function handleLlmHttpError(response: Response, source?: string): Promise<never> {
  const status = response.status;
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    // best effort
  }

  const detail = bodyText.length > 0 ? `: ${redactProviderErrorText(bodyText.slice(0, 500), source)}` : '';

  if (status === 401 || status === 403) {
    throw new LlmAuthError(`LLM authentication failed (HTTP ${status})${detail}`, status);
  }

  if (status === 429) {
    throw new LlmRateLimitError(`LLM rate limit exceeded (HTTP 429)${detail}`, status);
  }

  if (status >= 500) {
    throw new LlmServerError(`LLM server error (HTTP ${status})${detail}`, status);
  }

  throw new LlmServerError(`LLM request failed (HTTP ${status})${detail}`, status);
}

export function normalizeLlmTransportError(err: unknown, context: string): StructuredLlmError {
  if (isStructuredLlmError(err)) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new LlmTimeoutError(`${context} aborted due to timeout`);
  }
  if (err instanceof TypeError) {
    return new LlmServerError(`Network error calling ${context}: ${err.message}`);
  }
  return new LlmServerError(`Unexpected error calling ${context}: ${err instanceof Error ? err.message : String(err)}`);
}
