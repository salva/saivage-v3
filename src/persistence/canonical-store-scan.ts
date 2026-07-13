import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { validateCardHistoryInvariant, validateParsedCards } from '../cards/validator.js';
import type { CardRecord } from '../schemas/index.js';
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
import {
  assertIssuedProjectRootObservation,
  type ObservedProjectRoot,
} from './canonical-root-observation.js';
import {
  cleanupDurableReplacementTemporaries,
  durableReplacementTemporaryTargetBasename,
  durablyReplaceFile,
  publishDirectory,
} from './durable-file-replacement.js';
import { readDeletedCardIds } from './deleted-card-ids.js';

const CARD_NAMESPACE_ENTRIES = new Set(['card', 'brief', 'status', 'review', 'conversations']);
const SLOT_ENTRIES = new Set(['versions', 'index.json']);

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

export interface CanonicalStoreGeneration {
  readonly cards: ReadonlyMap<string, ScannedCard>;
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse JSON at '${path}': ${(error as Error).message}`);
  }
}

function synchronizeDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error(`Required canonical store directory is not a directory: '${path}'.`);
    return;
  }
  publishDirectory(path);
}

function assertOnlyEntries(path: string, allowed: ReadonlySet<string>): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw new Error(`Unknown canonical store entry: '${join(path, entry.name)}'.`);
    if (entry.name !== 'index.json' && !entry.isDirectory()) throw new Error(`Canonical store entry is not a directory: '${join(path, entry.name)}'.`);
    if (entry.name === 'index.json' && !entry.isFile()) throw new Error(`Derived index is not a regular file: '${join(path, entry.name)}'.`);
  }
}

function cleanupVersionTemporaries(versionsPath: string): void {
  const targets = readdirSync(versionsPath)
    .map(durableReplacementTemporaryTargetBasename)
    .filter((target): target is string => target !== null)
    .filter((target) => {
      try {
        parseCardVersionFilename(target);
        return true;
      } catch {
        return false;
      }
    });
  cleanupDurableReplacementTemporaries(versionsPath, targets);
}

function enumerateCardArtifacts(cardId: string, versionsPath: string): CardVersionArtifact[] {
  cleanupVersionTemporaries(versionsPath);
  return readdirSync(versionsPath, { withFileTypes: true }).map((entry) => {
    const path = join(versionsPath, entry.name);
    if (!entry.isFile()) throw new Error(`Canonical card version is not a regular file: '${path}'.`);
    const version = parseCardVersionFilename(entry.name, path);
    return parseCardVersionArtifact(parseJson(path), path, { cardId, version });
  });
}

function writeCardIndex(cardPath: string, cardId: string, artifacts: readonly CardVersionArtifact[], current: CardVersionArtifact): void {
  const versions = Object.fromEntries([...artifacts]
    .sort((left, right) => left.version - right.version)
    .map((artifact) => [String(artifact.version), {
      version: artifact.version,
      committed_at: artifact.committed_at,
      history: artifact.history,
    }]));
  const bytes = Buffer.from(`${JSON.stringify({ kind: 'card-index', format_version: 1, card_id: cardId, latest: current.version, versions }, null, 2)}\n`);
  durablyReplaceFile(join(cardPath, 'index.json'), bytes);
}

function scanRecordSlot(cardNamespace: string, cardId: string, slot: AuthoredRecordSlot): ScannedRecordSlot {
  const slotPath = join(cardNamespace, slot);
  ensureDirectory(slotPath);
  const versionsPath = join(slotPath, 'versions');
  ensureDirectory(versionsPath);
  cleanupDurableReplacementTemporaries(slotPath, ['index.json']);
  cleanupVersionTemporaries(versionsPath);
  assertOnlyEntries(slotPath, SLOT_ENTRIES);

  const artifacts = readdirSync(versionsPath, { withFileTypes: true }).map((entry) => {
    const path = join(versionsPath, entry.name);
    if (!entry.isFile()) throw new Error(`Canonical record version is not a regular file: '${path}'.`);
    const version = parseCardVersionFilename(entry.name, path);
    return parseRecordVersionArtifact(parseJson(path), path, { cardId, slot, version });
  }).sort((left, right) => left.version - right.version);

  const openArtifacts = artifacts.filter((artifact) => artifact.state === 'open');
  if (openArtifacts.length > 1) throw new Error(`Record slot '${slotPath}' contains more than one open artifact.`);
  const open = openArtifacts[0] ?? null;
  if (open !== null && open.version !== artifacts.at(-1)?.version) throw new Error(`Record slot '${slotPath}' contains an older orphan open artifact.`);
  const closed = artifacts.filter((artifact) => artifact.state === 'closed');
  const latest = closed.at(-1) ?? null;
  const versions = Object.fromEntries(artifacts.map((artifact) => [String(artifact.version), {
    version: artifact.version,
    state: artifact.state,
    opened_at: artifact.opened_at,
    committed_at: artifact.committed_at,
    closed_at: artifact.closed_at,
    discarded_at: artifact.discarded_at,
    reason: artifact.reason,
    writer: artifact.writer,
    format: artifact.format,
    schema: artifact.schema,
    card_version_seq: artifact.card_version_seq,
    size: Buffer.byteLength(artifact.content),
  }]));
  const bytes = Buffer.from(`${JSON.stringify({
    kind: 'record-slot-index', format_version: 1, card_id: cardId, slot,
    latest: latest?.version ?? null, open: open?.version ?? null, versions,
  }, null, 2)}\n`);
  durablyReplaceFile(join(slotPath, 'index.json'), bytes);
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
  const allowedDirectories = new Set(['card', 'card/versions', 'brief', 'brief/versions']);
  for (const relative of incompleteNamespaceEntries(namespacePath)) {
    const path = join(namespacePath, relative);
    if (lstatSync(path).isDirectory()) {
      if (!allowedDirectories.has(relative)) throw new Error(`Unknown incomplete card namespace directory: '${path}'.`);
      continue;
    }
    if (relative === 'brief/versions/1.json') {
      const artifact = parseRecordVersionArtifact(parseJson(path), path, { cardId, slot: 'brief', version: 1 });
      if (artifact.state !== 'closed' || artifact.card_version_seq !== 1) throw new Error(`Initial brief artifact is invalid: '${path}'.`);
      continue;
    }
    if (relative === 'brief/index.json' || relative === 'card/index.json') continue;
    const parent = relative.slice(0, relative.lastIndexOf('/'));
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    const target = durableReplacementTemporaryTargetBasename(name);
    const permittedTarget =
      (parent === 'brief/versions' && target === '1.json') ||
      (parent === 'card/versions' && target === '1.json') ||
      (parent === 'brief' && target === 'index.json') ||
      (parent === 'card' && target === 'index.json');
    if (!permittedTarget) throw new Error(`Unknown incomplete card namespace file: '${path}'.`);
  }
}

export function hasCanonicalCardArtifact(namespacePath: string): boolean {
  const versionsPath = join(namespacePath, 'card', 'versions');
  if (!existsSync(versionsPath)) return false;
  for (const entry of readdirSync(versionsPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      parseCardVersionFilename(entry.name);
      return true;
    } catch {
      // Exact temporaries and unknown entries do not establish commitment.
    }
  }
  return false;
}

function cleanupIncompleteNamespaces(cardsPath: string): void {
  for (const entry of readdirSync(cardsPath, { withFileTypes: true })) {
    const namespacePath = join(cardsPath, entry.name);
    if (!entry.isDirectory()) throw new Error(`Card namespace is not a directory: '${namespacePath}'.`);
    if (hasCanonicalCardArtifact(namespacePath)) continue;
    discardIncompleteCardNamespace(cardsPath, entry.name);
  }
}

export function discardIncompleteCardNamespace(cardsPath: string, cardId: string): void {
  const namespacePath = join(cardsPath, cardId);
  validateIncompleteCardNamespace(namespacePath, cardId);
  rmSync(namespacePath, { recursive: true });
  synchronizeDirectory(cardsPath);
}

function scanCard(cardsPath: string, cardId: string): ScannedCard {
  const namespacePath = join(cardsPath, cardId);
  assertOnlyEntries(namespacePath, CARD_NAMESPACE_ENTRIES);
  const cardPath = join(namespacePath, 'card');
  if (!existsSync(cardPath) || !lstatSync(cardPath).isDirectory()) throw new Error(`Card '${cardId}' is missing its card directory.`);
  cleanupDurableReplacementTemporaries(cardPath, ['index.json']);
  assertOnlyEntries(cardPath, SLOT_ENTRIES);
  const versionsPath = join(cardPath, 'versions');
  if (!existsSync(versionsPath) || !lstatSync(versionsPath).isDirectory()) throw new Error(`Card '${cardId}' is missing its versions directory.`);
  const artifacts = enumerateCardArtifacts(cardId, versionsPath).sort((left, right) => left.version - right.version);
  const current = selectCurrentCardVersion(artifacts, versionsPath);
  for (let version = 1; version <= current.version; version += 1) {
    if (artifacts[version - 1]?.version !== version) throw new Error(`Card '${cardId}' canonical versions are not contiguous at version ${version}.`);
  }
  validateCardHistoryInvariant(cardId, current.version, versionsPath, artifacts.flatMap((artifact) => artifact.history ? [artifact.history] : []));
  writeCardIndex(cardPath, cardId, artifacts, current);
  const records = Object.fromEntries(authoredRecordSlotValues.map((slot) => [slot, scanRecordSlot(namespacePath, cardId, slot)])) as Record<AuthoredRecordSlot, ScannedRecordSlot>;
  if (records.brief.latest === null) throw new Error(`Current card '${cardId}' is missing a required closed brief artifact.`);
  return Object.freeze({ artifacts: Object.freeze(artifacts), current, records: Object.freeze(records) });
}

export function restabilizeCanonicalStore(
  projectRoot: string,
  cardsPath: string,
  observation: ObservedProjectRoot,
): CanonicalStoreGeneration {
  assertIssuedProjectRootObservation(observation);
  const canonicalProjectRoot = realpathSync(projectRoot);
  const canonicalCardsPath = realpathSync(cardsPath);
  if (canonicalCardsPath !== observation.cardsPath) throw new Error(`Project-root observation belongs to '${observation.cardsPath}', not '${canonicalCardsPath}'.`);
  if (realpathSync(join(canonicalProjectRoot, '.saivage', 'cards')) !== canonicalCardsPath) {
    throw new Error(`Canonical cards path '${canonicalCardsPath}' does not belong to project root '${canonicalProjectRoot}'.`);
  }
  cleanupIncompleteNamespaces(cardsPath);
  const cards = new Map<string, ScannedCard>();
  for (const entry of readdirSync(cardsPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) throw new Error(`Card namespace is not a directory: '${join(cardsPath, entry.name)}'.`);
    cards.set(entry.name, scanCard(cardsPath, entry.name));
  }
  const root = cards.get('project');
  if (!root || root.current.version !== observation.selected.version || root.current.committed_at !== observation.selected.committed_at) {
    throw new Error(`Canonical project root changed after observation at '${join(cardsPath, 'project')}'.`);
  }
  const currentCards: CardRecord[] = [...cards.values()].map((card) => card.current.card);
  validateParsedCards({ cards: currentCards, maxDepth: 5 });
  const deletedIds = new Set(readDeletedCardIds(projectRoot));
  for (const card of currentCards) if (deletedIds.has(card.id)) throw new Error(`Live card '${card.id}' is also reserved as deleted.`);
  return Object.freeze({ cards });
}
