import { z } from 'zod';

import {
  cardHistoryEntrySchema,
  persistedCardRecordSchema,
  validatePersistedCardLifecycle,
  type CardHistoryEntry,
  type CardRecord,
} from '../schemas/index.js';

export const cardVersionArtifactSchema = z
  .object({
    kind: z.literal('card-version'),
    format_version: z.literal(1),
    card_id: z.string().min(1),
    version: z.number().int().safe().positive(),
    committed_at: z.string().datetime(),
    card: persistedCardRecordSchema,
    history: cardHistoryEntrySchema.nullable(),
  })
  .strict();

export interface CardVersionArtifact {
  kind: 'card-version';
  format_version: 1;
  card_id: string;
  version: number;
  committed_at: string;
  card: CardRecord;
  history: CardHistoryEntry | null;
}

export function parseCardVersionFilename(filename: string, path = filename): number {
  if (!/^[1-9]\d*\.json$/.test(filename)) throw new Error(`Invalid canonical card version filename at '${path}': '${filename}'.`);
  const version = Number(filename.slice(0, -'.json'.length));
  if (!Number.isSafeInteger(version)) throw new Error(`Canonical card version filename at '${path}' exceeds the safe integer range.`);
  return version;
}

export function parseCardVersionArtifact(
  raw: unknown,
  path: string,
  expected?: { cardId: string; version: number },
): CardVersionArtifact {
  const parsed = cardVersionArtifactSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Card version artifact at '${path}' is invalid: ${parsed.error.message}`);
  const artifact = parsed.data;
  try {
    validatePersistedCardLifecycle(artifact.card);
  } catch (error) {
    throw new Error(`Card version artifact at '${path}' has invalid lifecycle fields: ${(error as Error).message}`);
  }
  if (artifact.card.status !== artifact.card.lifecycle.status) {
    throw new Error(`Card version artifact at '${path}' has a status that does not match lifecycle.status.`);
  }
  if (artifact.card_id !== artifact.card.id || artifact.version !== artifact.card.version_seq) {
    throw new Error(`Card version artifact at '${path}' has inconsistent envelope and card identity.`);
  }
  if (expected && (artifact.card_id !== expected.cardId || artifact.version !== expected.version)) {
    throw new Error(`Card version artifact at '${path}' does not match its card and version path.`);
  }
  if (artifact.history !== null) {
    if (artifact.history.card_id !== artifact.card_id || artifact.history.version_seq !== artifact.version - 1) {
      throw new Error(`Card version artifact at '${path}' has history inconsistent with its published version.`);
    }
  } else if (artifact.version !== 1) {
    throw new Error(`Card version artifact at '${path}' version ${artifact.version} requires a history entry.`);
  }
  return artifact as CardVersionArtifact;
}

export function selectCurrentCardVersion(artifacts: readonly CardVersionArtifact[], path: string): CardVersionArtifact {
  if (artifacts.length === 0) throw new Error(`No canonical card version artifacts exist at '${path}'.`);
  const byVersion = new Map<number, CardVersionArtifact>();
  for (const artifact of artifacts) {
    if (byVersion.has(artifact.version)) throw new Error(`Ambiguous canonical card version ${artifact.version} at '${path}'.`);
    byVersion.set(artifact.version, artifact);
  }
  return artifacts.reduce((latest, artifact) => (artifact.version > latest.version ? artifact : latest));
}
