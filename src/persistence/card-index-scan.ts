import {
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { validateCardHistoryInvariant, validateParsedCards } from '../cards/validator.js';
import { cardHistoryEntrySchema, cardRecordSchema, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import {
  parseCardVersionArtifact,
  parseCardVersionFilename,
  selectCurrentCardVersion,
  type CardVersionArtifact,
} from './canonical-card-artifacts.js';
import {
  authoredRecordSlotValues,
  parseRecordVersionArtifact,
  type AuthoredRecordSlot,
  type RecordVersionArtifact,
} from './canonical-record-artifacts.js';
import { cardIdSchema, nonRootCardIdSchema } from '../schemas/validators.js';

export interface ScannedRecordSlot {
  readonly artifacts: readonly RecordVersionArtifact[];
  readonly latest: RecordVersionArtifact | null;
  readonly open: RecordVersionArtifact | null;
}

export interface CardArtifactIndex {
  readonly artifacts: readonly CardVersionArtifact[];
  readonly current: CardVersionArtifact;
  readonly records: Readonly<Record<AuthoredRecordSlot, ScannedRecordSlot>>;
}

export interface CardIndexProjection {
  readonly cards: Map<string, CardArtifactIndex>;
  readonly tombstonedIds: Set<string>;
}

export interface CardTombstone {
  readonly kind: 'card-tombstone';
  readonly format_version: 1;
  readonly card_id: string;
  readonly deleted_at: string;
  readonly final_card: CardRecord;
  readonly deletion_history: CardHistoryEntry;
}

function parseJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`Failed to parse JSON at '${path}': ${(error as Error).message}`); }
}

export function isCanonicalCardId(cardId: string): boolean {
  return cardIdSchema.safeParse(cardId).success;
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`Card store entry is not a directory: '${path}'.`);
}

function enumerateCardArtifacts(cardId: string, versionsPath: string): CardVersionArtifact[] {
  return readdirSync(versionsPath, { withFileTypes: true }).filter((entry) => /^[1-9][0-9]*\.json$/u.test(entry.name)).map((entry) => {
    const path = join(versionsPath, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Canonical card version is not a regular file: '${path}'.`);
    const version = parseCardVersionFilename(entry.name, path);
    return parseCardVersionArtifact(parseJson(path), path, { cardId, version });
  }).sort((left, right) => left.version - right.version);
}

function emptySlot(): ScannedRecordSlot {
  return Object.freeze({ artifacts: Object.freeze([]), latest: null, open: null });
}

function scanRecordSlot(cardNamespace: string, cardId: string, slot: AuthoredRecordSlot): ScannedRecordSlot {
  const slotPath = join(cardNamespace, slot);
  try { assertDirectory(slotPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySlot(); throw error; }
  const versionsPath = join(slotPath, 'versions');
  try { assertDirectory(versionsPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySlot(); throw error; }
  const artifacts = readdirSync(versionsPath, { withFileTypes: true }).filter((entry) => /^[1-9][0-9]*\.json$/u.test(entry.name)).map((entry) => {
    const path = join(versionsPath, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Canonical record version is not a regular file: '${path}'.`);
    const version = parseCardVersionFilename(entry.name, path);
    return parseRecordVersionArtifact(parseJson(path), path, { cardId, slot, version });
  }).sort((left, right) => left.version - right.version);
  artifacts.forEach((artifact, index) => {
    if (artifact.version !== index + 1) throw new Error(`Record slot '${slotPath}' has a version gap at ${index + 1}.`);
  });
  const openArtifacts = artifacts.filter((artifact) => artifact.state === 'open');
  if (openArtifacts.length > 1) throw new Error(`Record slot '${slotPath}' contains more than one open artifact.`);
  const open = openArtifacts[0] ?? null;
  if (open !== null && open.version !== artifacts.at(-1)?.version) throw new Error(`Record slot '${slotPath}' contains an older orphan open artifact.`);
  const latest = artifacts.filter((artifact) => artifact.state === 'closed').at(-1) ?? null;
  return Object.freeze({ artifacts: Object.freeze(artifacts), latest, open });
}

export function hasCanonicalCardArtifact(namespacePath: string): boolean {
  try { readFileSync(join(namespacePath, 'card', 'versions', '1.json')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export function parseCardTombstone(raw: unknown, path: string, cardId: string): CardTombstone {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`Card tombstone is invalid at '${path}'.`);
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'card_id,deleted_at,deletion_history,final_card,format_version,kind') throw new Error(`Card tombstone has unexpected fields at '${path}'.`);
  if (value.kind !== 'card-tombstone' || value.format_version !== 1 || value.card_id !== cardId) throw new Error(`Card tombstone identity is invalid at '${path}'.`);
  if (typeof value.deleted_at !== 'string' || Number.isNaN(Date.parse(value.deleted_at))) throw new Error(`Card tombstone timestamp is invalid at '${path}'.`);
  const finalCard = cardRecordSchema.parse(value.final_card);
  const deletionHistory = cardHistoryEntrySchema.parse(value.deletion_history);
  if (finalCard.id !== cardId || deletionHistory.card_id !== cardId || deletionHistory.snapshot.id !== cardId) throw new Error(`Card tombstone card ids do not match at '${path}'.`);
  if (deletionHistory.kind !== 'delete' && deletionHistory.kind !== 'archive') throw new Error(`Card tombstone history kind is invalid at '${path}'.`);
  if (deletionHistory.version_seq !== finalCard.version_seq || JSON.stringify(deletionHistory.snapshot) !== JSON.stringify(finalCard)) throw new Error(`Card tombstone final snapshot is inconsistent at '${path}'.`);
  if (deletionHistory.changed_at !== value.deleted_at || deletionHistory.changed_fields.length !== 1 || deletionHistory.changed_fields[0] !== '__deleted__') throw new Error(`Card tombstone deletion history is inconsistent at '${path}'.`);
  return Object.freeze({ kind: 'card-tombstone', format_version: 1, card_id: cardId, deleted_at: value.deleted_at, final_card: finalCard, deletion_history: deletionHistory });
}

export function readCardNamespace(cardsPath: string, cardId: string): CardArtifactIndex {
  const namespacePath = join(cardsPath, cardId);
  const cardPath = join(namespacePath, 'card');
  const versionsPath = join(cardPath, 'versions');
  try { assertDirectory(cardPath); assertDirectory(versionsPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Card '${cardId}' is missing its card versions directory.`, { cause: error }); throw error; }
  if (!lstatSync(versionsPath).isDirectory()) throw new Error(`Card '${cardId}' versions path is not a directory.`);
  const artifacts = enumerateCardArtifacts(cardId, versionsPath);
  const current = selectCurrentCardVersion(artifacts, versionsPath);
  artifacts.forEach((artifact, index) => { if (artifact.version !== index + 1) throw new Error(`Card '${cardId}' canonical versions are not contiguous at version ${index + 1}.`); });
  validateCardHistoryInvariant(cardId, current.version, versionsPath, artifacts.flatMap((artifact) => artifact.history ? [artifact.history] : []));
  const records = Object.fromEntries(authoredRecordSlotValues.map((slot) => [slot, scanRecordSlot(namespacePath, cardId, slot)])) as Record<AuthoredRecordSlot, ScannedRecordSlot>;
  if (records.brief.latest === null) throw new Error(`Current card '${cardId}' is missing a required closed brief artifact.`);
  return Object.freeze({ artifacts: Object.freeze(artifacts), current, records: Object.freeze(records) });
}

export function scanCardIndex(cardsPath: string): CardIndexProjection {
  try { assertDirectory(cardsPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Cannot enumerate canonical project cards at '${cardsPath}'.`, { cause: error }); throw error; }
  const cards = new Map<string, CardArtifactIndex>();
  const tombstonedIds = new Set<string>();
  for (const entry of readdirSync(cardsPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const namespacePath = join(cardsPath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isCanonicalCardId(entry.name)) continue;
    const tombstonePath = join(namespacePath, 'tombstone.json');
    let tombstoneRaw: unknown;
    try {
      tombstoneRaw = JSON.parse(readFileSync(tombstonePath, 'utf8')) as unknown;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      tombstoneRaw = undefined;
    }
    if (tombstoneRaw !== undefined) {
      if (entry.name === 'project') throw new Error('The project card cannot be tombstoned.');
      nonRootCardIdSchema.parse(entry.name);
      parseCardTombstone(tombstoneRaw, tombstonePath, entry.name);
      tombstonedIds.add(entry.name);
      continue;
    }
    if (!hasCanonicalCardArtifact(namespacePath)) {
      continue;
    }
    cards.set(entry.name, readCardNamespace(cardsPath, entry.name));
  }
  const root = cards.get('project');
  if (!root) throw new Error('Canonical project card is missing.');
  if (tombstonedIds.has('project')) throw new Error('The project card cannot be tombstoned.');
  validateParsedCards({ cards: [...cards.values()].map((entry) => entry.current.card), maxDepth: 5 });
  return { cards, tombstonedIds };
}
