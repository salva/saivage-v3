export type ContractMismatchSubtype =
  | 'terminal_tool_missing'
  | 'terminal_tool_unexpected'
  | 'tool_arguments_invalid_json'
  | 'tool_arguments_schema_violation'
  | 'legacy_message_shape'
  | 'unknown';

export type LlmFailure =
  | { kind: 'auth_permanent'; provider: string; message: string; status: number }
  | { kind: 'rate_limit'; provider: string; message: string; status: number; retryAfterMs?: number; resetsAt?: string }
  | { kind: 'server_transient'; provider: string; message: string; status: number }
  | { kind: 'timeout'; provider: string; message: string }
  | { kind: 'contract_mismatch'; provider: string; message: string; subtype: ContractMismatchSubtype; status?: number }
  | { kind: 'capability_mismatch'; provider: string; message: string; model: string; requested: string[]; supported: string[] }
  | { kind: 'token_budget_exceeded'; provider: string; message: string; status: number }
  | { kind: 'parse_error'; provider: string; message: string; bodyPreview?: string }
  | { kind: 'cancelled'; provider: string; message: string; reason: 'abort' | 'timeout' }
  | { kind: 'unknown'; provider: string; message: string };

export class LlmRequestError extends Error {
  readonly failure: LlmFailure;
  constructor(failure: LlmFailure) {
    super(failure.message);
    this.name = 'LlmRequestError';
    this.failure = failure;
  }
}

export function unwrapFailure(err: unknown): LlmFailure {
  if (err instanceof LlmRequestError) return err.failure;
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unknown', provider: 'unknown', message };
}
