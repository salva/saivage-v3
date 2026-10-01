import { z } from 'zod';
import { sha256Hex } from '../schemas/index.js';
import { ConversationSessionIdSchema, type ConversationSessionId } from '../schemas/index.js';
import { providerExchangePayloadSchema } from './provider-exchange.js';

export function internalCompactionSummarySessionId(sourceSessionId: ConversationSessionId): `internal:compaction-summary:${string}` {
  return `internal:compaction-summary:${sha256Hex(sourceSessionId)}`;
}

const evidenceSessionIdSchema = z.union([
  ConversationSessionIdSchema,
  z.string().regex(/^internal:compaction-summary:[a-f0-9]{64}$/u),
]);

const providerExchangeLogDataSchema = z.object({
  session_id: evidenceSessionIdSchema,
  source_input_id: z.string().min(1),
  attempt_index: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  payload: providerExchangePayloadSchema,
}).strict();

type ProviderExchangeLogData = z.infer<typeof providerExchangeLogDataSchema>;

export const providerExchangeLogEntrySchema = z.object({ type: z.literal('provider_exchange'), data: providerExchangeLogDataSchema }).strict();
export type ProviderExchangeLogEntry = z.infer<typeof providerExchangeLogEntrySchema>;

export function providerExchangeLogId(data: Pick<ProviderExchangeLogData, 'session_id' | 'source_input_id' | 'attempt_index'>): string {
  return `provider-exchange:${encodeURIComponent(data.session_id)}:${encodeURIComponent(data.source_input_id)}:${data.attempt_index}`;
}
