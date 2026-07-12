import type { ReadModelChanges } from '../application/read-model-changes.js';
import { appendProviderExchangeLogEntry, type ProviderExchangeLogData } from './provider-exchange-log.js';
import type { AppLogEntry } from './app-log.js';

export interface ProviderExchangeMutationPort { append(data: ProviderExchangeLogData): AppLogEntry; }

export function createProviderExchangeMutationPort(projectRoot: string, changes: ReadModelChanges): ProviderExchangeMutationPort {
  return { append(data) { const result = appendProviderExchangeLogEntry(projectRoot, data); changes.agentsChanged(); return result; } };
}
