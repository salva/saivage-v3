import {
  providerExchangePayloadSchema,
  type ProviderExchangeAttempt,
  type ProviderExchangePayload,
} from '../contracts/provider-exchange.js';
import { redactForOutbound, redactTextForOutbound } from '../redaction/index.js';

type IndexedProviderExchangeAttempt = ProviderExchangeAttempt & { attempt_index: number };

export function projectProviderExchangeForPublication(
  attempt: IndexedProviderExchangeAttempt,
  assistantOutputIds: string[],
): ProviderExchangePayload {
  const base = {
    contract_id: redactText(attempt.contract_id),
    contract_name: redactText(attempt.contract_name),
    transport: attempt.transport,
    provider: redactText(attempt.provider),
    model: redactText(attempt.model),
    ...(attempt.account !== undefined ? { account: redactText(attempt.account) } : {}),
    source_input_id: attempt.source_input_id,
    attempt_index: attempt.attempt_index,
    request_params: redactForOutbound(attempt.request_params),
    started_at: attempt.started_at,
    completed_at: attempt.completed_at,
    ...(attempt.response_status !== undefined ? { response_status: attempt.response_status } : {}),
    ...(attempt.latency_ms !== undefined ? { latency_ms: attempt.latency_ms } : {}),
    terminal_tool_fired: attempt.terminal_tool_fired === null
      ? null
      : redactText(attempt.terminal_tool_fired),
  };

  const projected = attempt.status === 'ok'
    ? {
        ...base,
        status: 'ok' as const,
        ...(attempt.finish_reason !== undefined
          ? { finish_reason: attempt.finish_reason === null ? null : redactText(attempt.finish_reason) }
          : {}),
        ...(attempt.token_usage !== undefined ? { token_usage: attempt.token_usage } : {}),
        assistant_output_ids: assistantOutputIds,
      }
    : {
        ...base,
        status: 'error' as const,
        error: {
          name: redactText(attempt.error.name),
          message: redactText(attempt.error.message),
          ...(attempt.error.status !== undefined ? { status: attempt.error.status } : {}),
        },
      };

  return providerExchangePayloadSchema.parse(projected satisfies ProviderExchangePayload);
}

function redactText(value: string): string {
  return redactTextForOutbound(value);
}
