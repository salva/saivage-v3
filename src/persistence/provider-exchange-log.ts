import type { ConversationSessionId } from '../schemas/index.js';
import { publishFreshFile } from './replace-file.js';
import {
  internalCompactionSummarySessionId,
  providerExchangeLogEntrySchema,
  providerExchangeLogId,
  type ProviderExchangeLogEntry,
  type ProviderExchangePayload,
} from '../contracts/index.js';
import {
  admitGrowingFileTail,
  appendEnvelope,
  serializeGrowingEnvelope,
  readCanonicalBytesOrMissing,
  consumeGrowingRows,
} from './growing-file.js';
import { providerExchangeFile } from './layout.js';

function ownerSchema(owner: ConversationSessionId) {
  return providerExchangeLogEntrySchema.refine(
    (entry) =>
      entry.data.session_id === owner ||
      entry.data.session_id === internalCompactionSummarySessionId(owner),
    `Provider exchange does not belong to '${owner}'.`,
  );
}

function validateProviderEntries(
  path: string,
  entries: ProviderExchangeLogEntry[],
): ProviderExchangeLogEntry[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = providerExchangeLogId(entry.data);
    if (ids.has(id))
      throw new Error(`Provider exchange log '${path}' contains duplicate logical id '${id}'.`);
    ids.add(id);
  }
  return entries;
}

export function readProviderExchangeEntries(projectRoot: string, owner: ConversationSessionId) {
  const path = providerExchangeFile(projectRoot, owner);
  const bytes = readCanonicalBytesOrMissing(path);
  if (bytes === null) return [];
  return consumeGrowingRows(path, bytes, ownerSchema(owner), (rows) =>
    validateProviderEntries(path, rows),
  );
}

export function appendProviderExchangeEntry(
  projectRoot: string,
  owner: ConversationSessionId,
  entry: ProviderExchangeLogEntry,
): void {
  const path = providerExchangeFile(projectRoot, owner);
  const bytes = serializeGrowingEnvelope([ownerSchema(owner).parse(entry)]);
  admitGrowingFileTail(path, ownerSchema(owner), (rows) => {
    validateProviderEntries(path, rows);
  });
  const result = appendEnvelope(path, bytes);
  // Evidence belongs to an established conversation root; missing directories fail at publication.
  if (result.kind === 'missing') publishFreshFile(path, bytes);
}

export function readLatestProviderExchangePayload(
  projectRoot: string,
  sessionId: ConversationSessionId,
): ProviderExchangePayload | null {
  let latest: { timestamp: string; attemptIndex: number; payload: ProviderExchangePayload } | null =
    null;
  for (const { data } of readProviderExchangeEntries(projectRoot, sessionId)) {
    if (data.session_id !== sessionId) continue;
    if (
      latest === null ||
      data.timestamp.localeCompare(latest.timestamp) > 0 ||
      (data.timestamp === latest.timestamp && data.attempt_index > latest.attemptIndex)
    )
      latest = {
        timestamp: data.timestamp,
        attemptIndex: data.attempt_index,
        payload: data.payload,
      };
  }
  return latest?.payload ?? null;
}
