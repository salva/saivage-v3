import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateParsedCards } from '../cards/validator.js';
import { cardHistoryEntrySchema, cardRecordSchema, nonRootCardIdSchema, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { parseCardVersionArtifact, type CardVersionArtifact } from './canonical-card-artifacts.js';
import { parseRecordVersionArtifact } from './canonical-record-artifacts.js';
import { parseCardTombstone, readCardNamespace, scanCardIndex, type CardArtifactIndex, type CardIndexProjection, type CardTombstone } from './card-index-scan.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';

export type CardIdentityFactory = () => string;

function cardsRoot(projectRoot: string): string { return join(projectRoot, '.saivage', 'cards'); }
function namespacePath(projectRoot: string, cardId: string): string { return join(cardsRoot(projectRoot), cardId); }
function cardVersionPath(projectRoot: string, cardId: string, version: number): string { return join(namespacePath(projectRoot, cardId), 'card', 'versions', `${version}.json`); }
function briefVersionPath(projectRoot: string, cardId: string): string { return join(namespacePath(projectRoot, cardId), 'brief', 'versions', '1.json'); }

function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }

export function probeCardTombstone(projectRoot: string, cardId: string): CardTombstone | null {
  const path = join(namespacePath(projectRoot, cardId), 'tombstone.json');
  try {
    const parsed = parseCardTombstone(JSON.parse(readFileSync(path, 'utf8')) as unknown, path, cardId);
    if (cardId === 'project') throw new Error('The project card cannot be tombstoned.');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readCard(projectRoot: string, cardId: string): CardRecord | null {
  if (probeCardTombstone(projectRoot, cardId)) return null;
  try { readFileSync(cardVersionPath(projectRoot, cardId, 1)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    return readCardNamespace(cardsRoot(projectRoot), cardId).current.card;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readCardArtifacts(projectRoot: string, cardId: string): CardArtifactIndex {
  if (probeCardTombstone(projectRoot, cardId)) throw new Error(`Card '${cardId}' is tombstoned.`);
  return readCardNamespace(cardsRoot(projectRoot), cardId);
}

export function readCardIndex(projectRoot: string): CardIndexProjection {
  return scanCardIndex(cardsRoot(projectRoot));
}

export function listCards(projectRoot: string): CardRecord[] {
  const model = readCardIndex(projectRoot);
  const cards = [...model.cards.values()].map((value) => value.current.card);
  validateParsedCards({ cards, maxDepth: 5 });
  return cards;
}

export function readCardHistory(projectRoot: string, cardId: string): CardHistoryEntry[] {
  return readCardArtifacts(projectRoot, cardId).artifacts.flatMap((artifact) => artifact.history ? [artifact.history] : []);
}

export function publishInitialCard(
  projectRoot: string,
  cardInput: Omit<CardRecord, 'id'>,
  briefContent: string,
  writer: 'analyst' | 'planner',
  cardIdentity: CardIdentityFactory = randomUUID,
  publicationTemporaryId?: PublicationTemporaryIdFactory,
): CardRecord {
  const cardId = cardIdentity();
  nonRootCardIdSchema.parse(cardId);
  const card = cardRecordSchema.parse({ ...cardInput, id: cardId });
  if (card.type === 'project') throw new Error('Non-root card creation cannot create a project card.');
  const namespace = namespacePath(projectRoot, cardId);
  mkdirSync(namespace);
  const committedAt = new Date().toISOString();
  const briefPath = briefVersionPath(projectRoot, cardId);
  const brief = {
    kind: 'record-version', format_version: 1, card_id: cardId, slot: 'brief', version: 1, state: 'closed',
    opened_at: committedAt, committed_at: committedAt, closed_at: committedAt, discarded_at: null, reason: null,
    writer, format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: briefContent,
  };
  const parsedBrief = parseRecordVersionArtifact(brief, briefPath, { cardId, slot: 'brief', version: 1 });
  replaceFile(briefPath, jsonBytes(parsedBrief), publicationTemporaryId);
  const path = cardVersionPath(projectRoot, cardId, 1);
  const artifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: cardId, version: 1, committed_at: committedAt, card, history: null }, path, { cardId, version: 1 });
  replaceFile(path, jsonBytes(artifact), publicationTemporaryId);
  return card;
}

export function publishInitialProjectCard(
  projectRoot: string,
  card: CardRecord,
  briefContent: string,
  writer: 'analyst' | 'planner',
  publicationTemporaryId?: PublicationTemporaryIdFactory,
): void {
  if (card.id !== 'project' || card.type !== 'project' || card.parent !== null || card.version_seq !== 1) throw new Error('Initial project card is invalid.');
  cardRecordSchema.parse(card);
  const namespace = namespacePath(projectRoot, 'project');
  mkdirSync(namespace);
  const committedAt = new Date().toISOString();
  const brief = { kind: 'record-version', format_version: 1, card_id: 'project', slot: 'brief', version: 1, state: 'closed', opened_at: committedAt, committed_at: committedAt, closed_at: committedAt, discarded_at: null, reason: null, writer, format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: briefContent };
  const briefPath = briefVersionPath(projectRoot, 'project');
  replaceFile(briefPath, jsonBytes(parseRecordVersionArtifact(brief, briefPath, { cardId: 'project', slot: 'brief', version: 1 })), publicationTemporaryId);
  const path = cardVersionPath(projectRoot, 'project', 1);
  replaceFile(path, jsonBytes(parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: 'project', version: 1, committed_at: committedAt, card, history: null }, path, { cardId: 'project', version: 1 })), publicationTemporaryId);
}

export function publishCardVersion(projectRoot: string, card: CardRecord, history: CardHistoryEntry | null, publicationTemporaryId?: PublicationTemporaryIdFactory): CardVersionArtifact {
  cardRecordSchema.parse(card);
  if (history) cardHistoryEntrySchema.parse(history);
  const current = readCard(projectRoot, card.id);
  if (!current || card.version_seq !== current.version_seq + 1) throw new Error(`Card '${card.id}' expected version ${current ? current.version_seq + 1 : 1}, got ${card.version_seq}.`);
  const path = cardVersionPath(projectRoot, card.id, card.version_seq);
  const artifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: card.version_seq, committed_at: new Date().toISOString(), card, history }, path, { cardId: card.id, version: card.version_seq });
  replaceFile(path, jsonBytes(artifact), publicationTemporaryId);
  return artifact;
}

export function publishCardTombstone(projectRoot: string, cardId: string, finalCard: CardRecord, deletionHistory: CardHistoryEntry, publicationTemporaryId?: PublicationTemporaryIdFactory): CardTombstone {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.');
  nonRootCardIdSchema.parse(cardId);
  const path = join(namespacePath(projectRoot, cardId), 'tombstone.json');
  const tombstone = parseCardTombstone({ kind: 'card-tombstone', format_version: 1, card_id: cardId, deleted_at: deletionHistory.changed_at, final_card: finalCard, deletion_history: deletionHistory }, path, cardId);
  replaceFile(path, jsonBytes(tombstone), publicationTemporaryId);
  return tombstone;
}
