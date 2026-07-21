import type { ProviderExchangePayload } from '../contracts/provider-exchange.js';
import { type ProviderExchangeLogData } from '../contracts/provider-exchange-log.js';
import { readAppLogEntries } from './app-log.js';

export { providerExchangeLogDataSchema, type ProviderExchangeLogData } from '../contracts/provider-exchange-log.js';

export function readProviderExchangeLogEntries(projectRoot: string, sessionId: string): ProviderExchangeLogData[] {
  return readAppLogEntries(projectRoot, 'provider_exchange')
    .map((entry) => entry.data)
    .filter((entry) => entry.session_id === sessionId);
}

export function readLatestProviderExchangePayload(projectRoot: string, sessionId: string): ProviderExchangePayload | null {
  const entries = readProviderExchangeLogEntries(projectRoot, sessionId);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.attempt_index - a.attempt_index);
  return entries[0]!.payload;
}
