import { z } from 'zod';
import { providerExchangePayloadSchema } from './provider-exchange.js';

export const providerExchangeLogDataSchema = z.object({
  session_id: z.string().min(1),
  source_input_id: z.string().min(1),
  attempt_index: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  payload: providerExchangePayloadSchema,
}).strict();

export type ProviderExchangeLogData = z.infer<typeof providerExchangeLogDataSchema>;

export function providerExchangeLogId(data: Pick<ProviderExchangeLogData, 'session_id' | 'source_input_id' | 'attempt_index'>): string {
  return `provider-exchange:${encodeURIComponent(data.session_id)}:${encodeURIComponent(data.source_input_id)}:${data.attempt_index}`;
}
