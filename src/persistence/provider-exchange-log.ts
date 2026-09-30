import type { ConversationSessionId } from '../schemas/index.js';
import { internalCompactionSummarySessionId, providerExchangeLogEntrySchema, providerExchangeLogId, type ProviderExchangeLogEntry } from '../contracts/index.js';
import type { ProviderExchangePayload } from '../contracts/provider-exchange.js';
import { admitGrowingFileTail, appendEnvelope, prepareGrowingEnvelope, publishFirstEnvelope, readStrictCanonicalGrowingFile } from './growing-file.js';
import { providerExchangeFile } from './layout.js';

function ownerSchema(owner: ConversationSessionId) {
  return providerExchangeLogEntrySchema.refine((entry) => entry.data.session_id === owner || entry.data.session_id === internalCompactionSummarySessionId(owner),
    `Provider exchange does not belong to '${owner}'.`);
}

export function readProviderExchangeEntries(projectRoot: string, owner: ConversationSessionId) {
  const path = providerExchangeFile(projectRoot, owner);
  let entries;
  try { entries = readStrictCanonicalGrowingFile(path, ownerSchema(owner)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = providerExchangeLogId(entry.data);
    if (ids.has(id)) throw new Error(`Provider exchange log '${path}' contains duplicate logical id '${id}'.`);
    ids.add(id);
  }
  return entries;
}

export function appendProviderExchangeEntry(projectRoot: string, owner: ConversationSessionId, entry: ProviderExchangeLogEntry): void {
  const path = providerExchangeFile(projectRoot, owner);
  const prepared = prepareGrowingEnvelope([entry], ownerSchema(owner));
  admitGrowingFileTail(path, ownerSchema(owner));
  const result = appendEnvelope(path, prepared.bytes);
  if (result.kind === 'missing') publishFirstEnvelope(path, prepared.bytes);
}

export function readLatestProviderExchangePayload(projectRoot: string, sessionId: ConversationSessionId): ProviderExchangePayload | null {
  let latest: { timestamp: string; attemptIndex: number; payload: ProviderExchangePayload } | null = null;
  for (const { data } of readProviderExchangeEntries(projectRoot, sessionId)) {
    if (data.session_id !== sessionId) continue;
    if (latest === null || data.timestamp.localeCompare(latest.timestamp) > 0 || (data.timestamp === latest.timestamp && data.attempt_index > latest.attemptIndex))
      latest = { timestamp: data.timestamp, attemptIndex: data.attempt_index, payload: data.payload };
  }
  return latest?.payload ?? null;
}
