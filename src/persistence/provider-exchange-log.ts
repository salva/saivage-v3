import { z } from 'zod';
import { providerExchangePayloadSchema, type ProviderExchangePayload } from '../contracts/provider-exchange.js';
import { readAppLogEntries, type AppLogEntry } from './app-log.js';

export const providerExchangeLogDataSchema = z.object({
  session_id: z.string().min(1),
  source_input_id: z.string().min(1),
  attempt_index: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  payload: providerExchangePayloadSchema,
}).strict();

export type ProviderExchangeLogData = z.infer<typeof providerExchangeLogDataSchema>;

export function providerExchangeAppLogEntry(data: ProviderExchangeLogData): AppLogEntry {
  const parsed = providerExchangeLogDataSchema.parse(data);
  return { id: `provider-exchange:${encodeURIComponent(parsed.session_id)}:${encodeURIComponent(parsed.source_input_id)}:${parsed.attempt_index}`, timestamp: parsed.timestamp, type: 'provider_exchange', data: parsed };
}

export function readProviderExchangeLogEntries(projectRoot: string, sessionId: string): ProviderExchangeLogData[] {
  return readAppLogEntries(projectRoot, 'provider_exchange')
    .map((entry) => providerExchangeLogDataSchema.safeParse(entry.data))
    .filter((parsed): parsed is z.SafeParseSuccess<ProviderExchangeLogData> => parsed.success)
    .map((parsed) => parsed.data)
    .filter((entry) => entry.session_id === sessionId);
}

export function readLatestProviderExchangePayload(projectRoot: string, sessionId: string): ProviderExchangePayload | null {
  const entries = readProviderExchangeLogEntries(projectRoot, sessionId);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.attempt_index - a.attempt_index);
  return entries[0]!.payload;
}
