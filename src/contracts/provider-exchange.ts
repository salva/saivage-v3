import { z } from 'zod';

const providerExchangeTransportSchema = z.enum(['generic', 'codex', 'openai-responses']);

const providerExchangeErrorSchema = z.object({
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
    terminal_conversation_output_id: z.string().min(1).nullable(),
    error: providerExchangeErrorSchema,
  }).strict(),
]);

export type ProviderExchangePayload = z.infer<typeof providerExchangePayloadSchema>;
export type ProviderExchangeOkPayload = Extract<ProviderExchangePayload, { status: 'ok' }>;
type ProviderExchangeErrorPayload = Extract<ProviderExchangePayload, { status: 'error' }>;

export type ProviderExchangeAttempt =
  | (Omit<ProviderExchangeOkPayload, 'assistant_output_ids' | 'attempt_index'> & { attempt_index?: number })
  | (Omit<ProviderExchangeErrorPayload, 'terminal_conversation_output_id' | 'attempt_index'> & { attempt_index?: number });

export type ProviderExchangePublicationContext = Readonly<{
  assistantOutputIds: readonly string[];
  terminalConversationOutputId: string | null;
}>;
