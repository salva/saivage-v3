import type { ProviderExchangePayload } from '../contracts/provider-exchange.js';
import { readAppLogEntries } from './app-log.js';

export { providerExchangeLogDataSchema, type ProviderExchangeLogData } from '../contracts/provider-exchange-log.js';

export function readLatestProviderExchangePayloadMap(projectRoot: string): ReadonlyMap<string, ProviderExchangePayload> {
  const latest = new Map<string, { timestamp: string; attemptIndex: number; payload: ProviderExchangePayload }>();
  for (const { data } of readAppLogEntries(projectRoot, 'provider_exchange')) {
    const selected = latest.get(data.session_id);
    if (
      selected === undefined
      || data.timestamp.localeCompare(selected.timestamp) > 0
      || (data.timestamp === selected.timestamp && data.attempt_index > selected.attemptIndex)
    ) {
      latest.set(data.session_id, { timestamp: data.timestamp, attemptIndex: data.attempt_index, payload: data.payload });
    }
  }
  return new Map([...latest].map(([sessionId, entry]) => [sessionId, entry.payload]));
}

export function readLatestProviderExchangePayload(projectRoot: string, sessionId: string): ProviderExchangePayload | null {
  return readLatestProviderExchangePayloadMap(projectRoot).get(sessionId) ?? null;
}
