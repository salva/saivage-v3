/**
 * Transport-layer LLM failure taxonomy. Contract / envelope-shape violations
 * are no longer modeled as failures — they are first-class values produced by
 * the verifier (see `contract-verifier.ts`) and routed through the loop driver.
 *
 * `provider_protocol_error` covers gateway / wire-level protocol breaches
 * (e.g. an HTTP 400 from a provider whose body the classifier cannot interpret).
 */
export type LlmTransportFailure =
  | { kind: 'auth_permanent'; provider: string; message: string; status: number }
  | { kind: 'rate_limit'; provider: string; message: string; status: number; retryAfterMs?: number; resetsAt?: string }
  | { kind: 'server_transient'; provider: string; message: string; status: number }
  | { kind: 'timeout'; provider: string; message: string }
  | { kind: 'provider_protocol_error'; provider: string; message: string; status: number; bodyPreview?: string }
  | { kind: 'capability_mismatch'; provider: string; message: string; model: string; requested: string[]; supported: string[] }
  | { kind: 'token_budget_exceeded'; provider: string; message: string; status: number }
  | { kind: 'parse_error'; provider: string; message: string; bodyPreview?: string }
  | { kind: 'cancelled'; provider: string; message: string; reason: 'abort' | 'timeout' }
  | { kind: 'unknown'; provider: string; message: string };

export class LlmRequestError extends Error {
  readonly failure: LlmTransportFailure;
  constructor(failure: LlmTransportFailure) {
    super(failure.message);
    this.name = 'LlmRequestError';
    this.failure = failure;
  }
}

export function unwrapFailure(err: unknown): LlmTransportFailure {
  if (err instanceof LlmRequestError) return err.failure;
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', provider: 'unknown', message };
}
