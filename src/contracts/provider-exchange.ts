import { z } from 'zod';

export const providerExchangeTransportSchema = z.enum(['generic', 'codex', 'openai-responses']);
export const providerExchangeStatusSchema = z.enum(['ok', 'error']);

export const providerExchangeErrorSchema = z.object({
  name: z.string().min(1),
  message: z.string(),
  status: z.number().int().optional(),
}).strict();

export const providerExchangePayloadSchema = z.discriminatedUnion('status', [
  z.object({
    contract_id: z.string().min(1),
    contract_name: z.string().min(1),
    transport: providerExchangeTransportSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    account: z.string().min(1).optional(),
    source_input_id: z.string().min(1),
    attempt_index: z.number().int().nonnegative(),
    request_params: z.record(z.string(), z.unknown()),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    status: z.literal('ok'),
    response_status: z.number().int().optional(),
    finish_reason: z.string().nullable().optional(),
    token_usage: z.object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    latency_ms: z.number().nonnegative().optional(),
    terminal_tool_fired: z.string().nullable(),
    assistant_output_ids: z.array(z.string()),
  }).strict(),
  z.object({
    contract_id: z.string().min(1),
    contract_name: z.string().min(1),
    transport: providerExchangeTransportSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    account: z.string().min(1).optional(),
    source_input_id: z.string().min(1),
    attempt_index: z.number().int().nonnegative(),
    request_params: z.record(z.string(), z.unknown()),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    status: z.literal('error'),
    response_status: z.number().int().optional(),
    latency_ms: z.number().nonnegative().optional(),
    terminal_tool_fired: z.string().nullable(),
    error: providerExchangeErrorSchema,
  }).strict(),
]);

export type ProviderExchangePayload = z.infer<typeof providerExchangePayloadSchema>;
export type ProviderExchangeOkPayload = Extract<ProviderExchangePayload, { status: 'ok' }>;
export type ProviderExchangeErrorPayload = Extract<ProviderExchangePayload, { status: 'error' }>;

export type ProviderExchangeAttempt =
  | (Omit<ProviderExchangeOkPayload, 'assistant_output_ids' | 'attempt_index'> & { attempt_index?: number })
  | (Omit<ProviderExchangeErrorPayload, 'attempt_index'> & { attempt_index?: number });

function orderedPayload(payload: ProviderExchangePayload): ProviderExchangePayload {
  const base = {
    contract_id: payload.contract_id,
    contract_name: payload.contract_name,
    transport: payload.transport,
    provider: payload.provider,
    model: payload.model,
    ...(payload.account ? { account: payload.account } : {}),
    source_input_id: payload.source_input_id,
    attempt_index: payload.attempt_index,
    request_params: payload.request_params,
    started_at: payload.started_at,
    completed_at: payload.completed_at,
    status: payload.status,
    ...(payload.response_status !== undefined ? { response_status: payload.response_status } : {}),
    ...(payload.status === 'ok' && payload.finish_reason !== undefined ? { finish_reason: payload.finish_reason } : {}),
    ...(payload.status === 'ok' && payload.token_usage !== undefined ? { token_usage: payload.token_usage } : {}),
    ...(payload.latency_ms !== undefined ? { latency_ms: payload.latency_ms } : {}),
    terminal_tool_fired: payload.terminal_tool_fired,
    ...(payload.status === 'ok'
      ? { assistant_output_ids: payload.assistant_output_ids }
      : { error: payload.error }),
  };
  return providerExchangePayloadSchema.parse(base);
}

export function serializeProviderExchangePayload(payload: ProviderExchangePayload): string {
  return JSON.stringify(orderedPayload(providerExchangePayloadSchema.parse(payload)));
}

export function parseProviderExchangePayload(content: unknown): ProviderExchangePayload {
  if (typeof content !== 'string') throw new Error('provider_exchange content must be a canonical JSON string.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`provider_exchange content is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return providerExchangePayloadSchema.parse(parsed);
}
