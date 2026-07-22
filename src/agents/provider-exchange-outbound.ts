import { z } from 'zod';

import { providerExchangePayloadSchema, type ProviderExchangePayload } from '../contracts/provider-exchange.js';
import { redactTextForOutbound, redactUrl } from '../redaction/text.js';

const commonRequestShape = {
  endpoint: z.string().url(),
  method: z.literal('POST'),
  stream: z.boolean(),
  offered_tools_count: z.number().int().nonnegative(),
};
const genericRequestParamsSchema = z.object({
  ...commonRequestShape,
  temperature: z.number(),
  max_tokens: z.number(),
}).strict();
const codexRequestParamsSchema = z.object(commonRequestShape).strict();
const responsesRequestParamsSchema = z.object({
  ...commonRequestShape,
  max_output_tokens: z.number().int().positive().optional(),
  include: z.array(z.string()).optional(),
  store: z.boolean().optional(),
  reasoning_keys: z.array(z.string()),
}).strict();

export function projectProviderExchange(exchange: ProviderExchangePayload): ProviderExchangePayload {
  const parsed = providerExchangePayloadSchema.parse(exchange);
  const base = {
    contract_id: parsed.contract_id,
    contract_name: parsed.contract_name,
    transport: parsed.transport,
    provider: parsed.provider,
    model: parsed.model,
    ...(parsed.account !== undefined ? { account: parsed.account } : {}),
    source_input_id: parsed.source_input_id,
    attempt_index: parsed.attempt_index,
    request_params: projectRequestParams(parsed.transport, parsed.request_params),
    started_at: parsed.started_at,
    completed_at: parsed.completed_at,
    ...(parsed.response_status !== undefined ? { response_status: parsed.response_status } : {}),
    ...(parsed.latency_ms !== undefined ? { latency_ms: parsed.latency_ms } : {}),
    terminal_tool_fired: parsed.terminal_tool_fired,
  };

  return providerExchangePayloadSchema.parse(parsed.status === 'ok' ? {
    ...base,
    status: 'ok',
    ...(parsed.finish_reason !== undefined ? { finish_reason: parsed.finish_reason } : {}),
    ...(parsed.token_usage !== undefined ? { token_usage: parsed.token_usage } : {}),
    assistant_output_ids: [...parsed.assistant_output_ids],
  } : {
    ...base,
    status: 'error',
    error: {
      name: parsed.error.name,
      message: redactTextForOutbound(parsed.error.message),
      ...(parsed.error.status !== undefined ? { status: parsed.error.status } : {}),
    },
  });
}

function projectRequestParams(
  transport: ProviderExchangePayload['transport'],
  value: Record<string, unknown>,
): Record<string, unknown> {
  switch (transport) {
    case 'generic': return projectEndpoint(genericRequestParamsSchema.parse(value));
    case 'codex': return projectEndpoint(codexRequestParamsSchema.parse(value));
    case 'openai-responses': return projectEndpoint(responsesRequestParamsSchema.parse(value));
  }
}

function projectEndpoint<T extends { endpoint: string }>(params: T): T {
  const endpoint = new URL(params.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('Provider exchange endpoint must use HTTP or HTTPS.');
  }
  return { ...params, endpoint: redactUrl(params.endpoint) };
}
