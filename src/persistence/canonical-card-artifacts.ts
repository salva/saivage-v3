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

const cardIndexVersionEntrySchema = z
  .object({
    version: z.number().int().safe().positive(),
    committed_at: z.string().datetime(),
    history: cardHistoryEntrySchema.nullable(),
  })
  .strict();

export const cardIndexSchema = z
  .object({
    kind: z.literal('card-index'),
    format_version: z.literal(1),
    card_id: z.string().min(1),
    latest: z.number().int().safe().positive(),
    versions: z.record(cardIndexVersionEntrySchema),
  })
  .strict();

export type CardIndexArtifact = z.infer<typeof cardIndexSchema>;

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

export function parseCardIndex(raw: unknown, path: string, expectedCardId?: string): CardIndexArtifact {
  const parsed = cardIndexSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Card index at '${path}' is invalid: ${parsed.error.message}`);
  for (const [key, entry] of Object.entries(parsed.data.versions)) {
    if (key !== String(entry.version)) throw new Error(`Card index at '${path}' has mismatched version key '${key}'.`);
    if (entry.version === 1 && entry.history !== null) throw new Error(`Card index at '${path}' version 1 must not contain history.`);
    if (entry.version > 1 && (entry.history === null || entry.history.card_id !== parsed.data.card_id || entry.history.version_seq !== entry.version - 1)) {
      throw new Error(`Card index at '${path}' version ${entry.version} has inconsistent history.`);
    }
  }
  if (expectedCardId !== undefined && parsed.data.card_id !== expectedCardId) {
    throw new Error(`Card index at '${path}' does not match card '${expectedCardId}'.`);
  }
  if (!(String(parsed.data.latest) in parsed.data.versions)) {
    throw new Error(`Card index at '${path}' latest version ${parsed.data.latest} has no version entry.`);
  }
  const highestVersion = Math.max(...Object.values(parsed.data.versions).map((entry) => entry.version));
  if (parsed.data.latest !== highestVersion) throw new Error(`Card index at '${path}' latest is not its highest version.`);
  return parsed.data;
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
