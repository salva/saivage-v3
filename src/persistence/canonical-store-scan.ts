import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
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
import { cleanupDurableReplacementTemporaries, durableReplacementTemporaryTargetBasename } from './durable-file-replacement.js';

const ACTIVE_NAMESPACE_ENTRIES = new Set(['card', 'brief', 'status', 'review', 'conversations', 'runtime']);
const TOMBSTONED_NAMESPACE_ENTRIES = new Set([...ACTIVE_NAMESPACE_ENTRIES, 'tombstone.json']);

export interface ScannedRecordSlot {
  readonly artifacts: readonly RecordVersionArtifact[];
  readonly latest: RecordVersionArtifact | null;
  readonly open: RecordVersionArtifact | null;
}

export interface ScannedCard {
  readonly artifacts: readonly CardVersionArtifact[];
  readonly current: CardVersionArtifact;
  readonly records: Readonly<Record<AuthoredRecordSlot, ScannedRecordSlot>>;
}

export interface ProjectStoreModel {
  readonly cards: Map<string, ScannedCard>;
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
  return cardId === 'project' || /^card-[1-9][0-9]*$/u.test(cardId);
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`Card store entry is not a directory: '${path}'.`);
}

function assertNamespaceEntries(path: string, allowed: ReadonlySet<string>): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (!allowed.has(entry.name)) throw new Error(`Unknown card namespace entry: '${child}'.`);
    if (entry.isSymbolicLink()) throw new Error(`Card namespace entry is a symlink: '${child}'.`);
    if (entry.name === 'tombstone.json' ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`Card namespace entry has the wrong type: '${child}'.`);
    }
  }
}

function cleanupVersionTemporaries(versionsPath: string): void {
  const targets = readdirSync(versionsPath)
    .map(durableReplacementTemporaryTargetBasename)
    .filter((target): target is string => target !== null)
    .filter((target) => { try { parseCardVersionFilename(target); return true; } catch { return false; } });
  cleanupDurableReplacementTemporaries(versionsPath, targets);
}

function enumerateCardArtifacts(cardId: string, versionsPath: string): CardVersionArtifact[] {
  cleanupVersionTemporaries(versionsPath);
  return readdirSync(versionsPath, { withFileTypes: true }).map((entry) => {
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
  if (!existsSync(slotPath)) return emptySlot();
  assertDirectory(slotPath);
  const entries = readdirSync(slotPath, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]!.name !== 'versions' || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) {
    throw new Error(`Record slot '${slotPath}' must contain only its versions directory.`);
  }
  const versionsPath = join(slotPath, 'versions');
  cleanupVersionTemporaries(versionsPath);
  const artifacts = readdirSync(versionsPath, { withFileTypes: true }).map((entry) => {
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

function incompleteNamespaceEntries(namespacePath: string): string[] {
  const results: string[] = [];
  const walk = (path: string, relative: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Ambiguous incomplete card namespace entry: '${childPath}'.`);
      results.push(childRelative);
      if (entry.isDirectory()) walk(childPath, childRelative);
      else if (!entry.isFile()) throw new Error(`Ambiguous incomplete card namespace entry: '${childPath}'.`);
    }
  };
  walk(namespacePath, '');
  return results;
}

export function validateIncompleteCardNamespace(namespacePath: string, cardId: string): void {
  if (!isCanonicalCardId(cardId)) throw new Error(`Invalid card namespace identity '${cardId}'.`);
  for (const versionsPath of [join(namespacePath, 'brief', 'versions'), join(namespacePath, 'card', 'versions')]) {
    if (existsSync(versionsPath) && lstatSync(versionsPath).isDirectory()) cleanupDurableReplacementTemporaries(versionsPath, ['1.json']);
  }
  const entries = incompleteNamespaceEntries(namespacePath);
  const directories = entries.filter((relative) => lstatSync(join(namespacePath, relative)).isDirectory()).sort();
  const files = entries.filter((relative) => !lstatSync(join(namespacePath, relative)).isDirectory()).sort();
  const allowedDirectoryPrefixes = [
    [],
    ['brief'],
    ['brief', 'brief/versions'],
    ['brief', 'brief/versions', 'card'],
    ['brief', 'brief/versions', 'card', 'card/versions'],
  ].map((prefix) => [...prefix].sort().join('\n'));
  if (!allowedDirectoryPrefixes.includes(directories.join('\n'))) {
    throw new Error(`Incomplete card namespace does not match the publication order: '${namespacePath}'.`);
  }
  if (files.length > 1 || (files.length === 1 && files[0] !== 'brief/versions/1.json')) {
    throw new Error(`Unknown incomplete card namespace file: '${join(namespacePath, files[0] ?? '')}'.`);
  }
  if (files.length === 1 && directories.join('\n') !== ['brief', 'brief/versions', 'card', 'card/versions'].sort().join('\n')) {
    throw new Error(`Initial brief exists before the complete card scaffold at '${namespacePath}'.`);
  }
  for (const relative of files) {
    const path = join(namespacePath, relative);
    const artifact = parseRecordVersionArtifact(parseJson(path), path, { cardId, slot: 'brief', version: 1 });
    if (artifact.state !== 'closed' || artifact.card_version_seq !== 1) throw new Error(`Initial brief artifact is invalid: '${path}'.`);
  }
}

export function hasCanonicalCardArtifact(namespacePath: string): boolean {
  return existsSync(join(namespacePath, 'card', 'versions', '1.json'));
}

export function discardIncompleteCardNamespace(cardsPath: string, cardId: string): void {
  const namespacePath = join(cardsPath, cardId);
  validateIncompleteCardNamespace(namespacePath, cardId);
  rmSync(namespacePath, { recursive: true });
  const fd = openSync(cardsPath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
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

export function loadActiveCardNamespace(cardsPath: string, cardId: string): ScannedCard {
  const namespacePath = join(cardsPath, cardId);
  assertNamespaceEntries(namespacePath, ACTIVE_NAMESPACE_ENTRIES);
  const cardPath = join(namespacePath, 'card');
  const versionsPath = join(cardPath, 'versions');
  if (!existsSync(cardPath) || !existsSync(versionsPath)) throw new Error(`Card '${cardId}' is missing its card versions directory.`);
  assertDirectory(cardPath);
  const cardEntries = readdirSync(cardPath, { withFileTypes: true });
  if (cardEntries.length !== 1 || cardEntries[0]!.name !== 'versions' || !cardEntries[0]!.isDirectory()) throw new Error(`Card '${cardId}' card directory must contain only versions.`);
  const artifacts = enumerateCardArtifacts(cardId, versionsPath);
  const current = selectCurrentCardVersion(artifacts, versionsPath);
  artifacts.forEach((artifact, index) => { if (artifact.version !== index + 1) throw new Error(`Card '${cardId}' canonical versions are not contiguous at version ${index + 1}.`); });
  validateCardHistoryInvariant(cardId, current.version, versionsPath, artifacts.flatMap((artifact) => artifact.history ? [artifact.history] : []));
  const records = Object.fromEntries(authoredRecordSlotValues.map((slot) => [slot, scanRecordSlot(namespacePath, cardId, slot)])) as Record<AuthoredRecordSlot, ScannedRecordSlot>;
  if (records.brief.latest === null) throw new Error(`Current card '${cardId}' is missing a required closed brief artifact.`);
  return Object.freeze({ artifacts: Object.freeze(artifacts), current, records: Object.freeze(records) });
}

export function loadProjectStore(cardsPath: string): ProjectStoreModel {
  if (!existsSync(cardsPath)) throw new Error(`Cannot enumerate canonical project cards at '${cardsPath}'.`);
  const cards = new Map<string, ScannedCard>();
  const tombstonedIds = new Set<string>();
  for (const entry of readdirSync(cardsPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const namespacePath = join(cardsPath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Card namespace is not a real directory: '${namespacePath}'.`);
    if (!isCanonicalCardId(entry.name)) throw new Error(`Invalid card namespace identity '${entry.name}'.`);
    const tombstonePath = join(namespacePath, 'tombstone.json');
    if (existsSync(tombstonePath)) {
      assertNamespaceEntries(namespacePath, TOMBSTONED_NAMESPACE_ENTRIES);
      parseCardTombstone(parseJson(tombstonePath), tombstonePath, entry.name);
      tombstonedIds.add(entry.name);
      continue;
    }
    if (!hasCanonicalCardArtifact(namespacePath)) {
      discardIncompleteCardNamespace(cardsPath, entry.name);
      continue;
    }
    cards.set(entry.name, loadActiveCardNamespace(cardsPath, entry.name));
  }
  const root = cards.get('project');
  if (!root) throw new Error('Canonical project card is missing.');
  if (tombstonedIds.has('project')) throw new Error('The project card cannot be tombstoned.');
  validateParsedCards({ cards: [...cards.values()].map((entry) => entry.current.card), maxDepth: 5 });
  return { cards, tombstonedIds };
}
