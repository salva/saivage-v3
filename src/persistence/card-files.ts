import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cardDepth, cardIdSchema, cardIdSegments, cardParentId, childCardId, nextCardSegment, nonRootCardIdSchema } from '../schemas/card-id.js';
import { cardHistoryEntrySchema, cardRecordSchema, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { cardChildReservationSchema, cardStreamRowSchema, parseCardVersionArtifact, validateCardStream, type CardChildReservation, type CardStreamRow, type CardTombstone, type CardVersionArtifact } from './canonical-card-artifacts.js';
import { recordVersionArtifactSchema, validateRecordStream } from './canonical-record-artifacts.js';
import { appendEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope, type GrowingFileIo } from './growing-file.js';
import { cardNamespace, cardRecordStreamFile, cardStreamFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';
import { validateParsedCards } from '../cards/validator.js';

export interface CardArtifactIndex { readonly rows: CardStreamRow[]; readonly artifacts: CardVersionArtifact[]; readonly reservations: CardChildReservation[]; readonly current: CardVersionArtifact; readonly tombstone: CardTombstone | null }

function requireDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Canonical card path '${path}' must be a real directory.`);
}

function exactStream(projectRoot: string, cardId: string): CardArtifactIndex {
  const path = cardStreamFile(projectRoot, cardId);
  const rows = readCanonicalGrowingFile(path, cardStreamRowSchema);
  return validateCardStream(rows, path, cardId);
}

function validateRequiredBrief(projectRoot: string, cardId: string): void {
  const path = cardRecordStreamFile(projectRoot, cardId, 'brief');
  validateRecordStream(readCanonicalGrowingFile(path, recordVersionArtifactSchema), path, cardId, 'brief');
}

function readLinkedArtifacts(projectRoot: string, targetId: string): CardArtifactIndex | null {
  cardIdSchema.parse(targetId);
  const segments = cardIdSegments(targetId);
  let currentId = 'project';
  let namespace = cardNamespace(projectRoot, currentId);
  try { requireDirectory(namespace); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let artifacts = exactStream(projectRoot, currentId);
  if (artifacts.tombstone) throw new Error('The project card cannot be tombstoned.');
  validateRequiredBrief(projectRoot, currentId);
  for (const segment of segments) {
    const nextId = childCardId(currentId, segment);
    if (!artifacts.current.card.children.includes(nextId)) return null;
    const childrenPath = join(namespace, 'children');
    requireDirectory(childrenPath);
    namespace = join(childrenPath, segment);
    requireDirectory(namespace);
    artifacts = exactStream(projectRoot, nextId);
    if (artifacts.tombstone) return null;
    validateRequiredBrief(projectRoot, nextId);
    currentId = nextId;
  }
  return artifacts;
}

export function readCard(projectRoot: string, cardId: string): CardRecord | null { return readLinkedArtifacts(projectRoot, cardId)?.current.card ?? null; }
export function readLinkedChildren(projectRoot: string, parentId: string): CardRecord[] {
  const parent = readCard(projectRoot, parentId);
  if (!parent) throw new Error(`Parent card '${parentId}' does not exist.`);
  const children = parent.children.flatMap((id) => { const child = readCard(projectRoot, id); return child ? [child] : []; });
  if (new Set(children.map((child) => child.position)).size !== children.length) throw new Error(`Parent '${parentId}' has duplicate active child positions.`);
  return children.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}
export function readCardArtifacts(projectRoot: string, cardId: string): CardArtifactIndex {
  const artifacts = readLinkedArtifacts(projectRoot, cardId);
  if (!artifacts) throw new Error(`Card '${cardId}' does not exist.`);
  return artifacts;
}

export function listCards(projectRoot: string): CardRecord[] {
  const root = readLinkedArtifacts(projectRoot, 'project');
  if (!root) return [];
  const cards: CardRecord[] = [];
  const visit = (artifacts: CardArtifactIndex): void => {
    const card = artifacts.current.card;
    cards.push(card);
    for (const childId of card.children) {
      const child = readLinkedArtifacts(projectRoot, childId);
      if (child) visit(child);
    }
  };
  visit(root);
  validateParsedCards({ cards, maxDepth: 5 });
  return cards;
}

export function readCardHistory(projectRoot: string, cardId: string): CardHistoryEntry[] {
  return readCardArtifacts(projectRoot, cardId).artifacts.flatMap((row) => row.history ? [row.history] : []);
}

function initialBrief(cardId: string, content: string, writer: 'analyst' | 'planner', stamp: string) {
  return { kind: 'record-revision' as const, format_version: 1 as const, card_id: cardId, slot: 'brief' as const, version: 1, revision_seq: 1, state: 'closed' as const, opened_at: stamp, committed_at: stamp, closed_at: stamp, discarded_at: null, reason: null, writer, format: 'markdown' as const, schema: 'record.brief.markdown.v1', card_version_seq: 1, content };
}

function publishInitialStreams(projectRoot: string, card: CardRecord, briefContent: string, writer: 'analyst' | 'planner', temporary?: PublicationTemporaryIdFactory): void {
  const stamp = new Date().toISOString();
  const brief = initialBrief(card.id, briefContent, writer, stamp);
  publishFirstEnvelope(cardRecordStreamFile(projectRoot, card.id, 'brief'), serializeGrowingEnvelope([brief], recordVersionArtifactSchema), temporary);
  const row = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: 1, committed_at: stamp, card, history: null }, cardStreamFile(projectRoot, card.id), { cardId: card.id, version: 1 });
  publishFirstEnvelope(cardStreamFile(projectRoot, card.id), serializeGrowingEnvelope([row], cardStreamRowSchema), temporary);
}

export function proveCreatedCardPublication(projectRoot: string, card: CardRecord): void {
  requireDirectory(cardNamespace(projectRoot, card.id));
  requireDirectory(join(cardNamespace(projectRoot, card.id), 'conversations'));
  const briefPath = cardRecordStreamFile(projectRoot, card.id, 'brief');
  const brief = validateRecordStream(readCanonicalGrowingFile(briefPath, recordVersionArtifactSchema), briefPath, card.id, 'brief');
  const stream = exactStream(projectRoot, card.id);
  if (brief.length !== 1 || brief[0]!.version !== 1 || brief[0]!.revision_seq !== 1 || brief[0]!.state !== 'closed' || stream.artifacts.length !== 1 || stream.tombstone !== null || stream.current.card.children.length !== 0 || JSON.stringify(stream.current.card) !== JSON.stringify(card)) throw new Error(`Claimed child '${card.id}' is not a complete initial publication.`);
}

export function reserveChildCardId(projectRoot: string, parentId: string, io?: GrowingFileIo): string {
  const stream = readCardArtifacts(projectRoot, parentId);
  if (stream.tombstone) throw new Error(`Cannot reserve a child under tombstoned card '${parentId}'.`);
  const segment = nextCardSegment(stream.reservations.at(-1)?.segment);
  const childId = childCardId(parentId, segment);
  const row = cardChildReservationSchema.parse({ kind: 'card-child-reservation', format_version: 1, card_id: parentId, segment, child_id: childId });
  validateCardStream([...stream.rows, row], cardStreamFile(projectRoot, parentId), parentId);
  appendEnvelope(cardStreamFile(projectRoot, parentId), serializeGrowingEnvelope([row], cardStreamRowSchema), io);
  return childId;
}

export function publishInitialCard(projectRoot: string, id: string, cardInput: Omit<CardRecord, 'id'>, briefContent: string, writer: 'analyst' | 'planner', temporary?: PublicationTemporaryIdFactory): CardRecord {
  if (cardInput.parent === null) throw new Error('A non-root card requires a parent.');
  nonRootCardIdSchema.parse(id);
  if (cardParentId(id) !== cardInput.parent) throw new Error(`Reserved card '${id}' is not a child of '${cardInput.parent}'.`);
  const card = cardRecordSchema.parse({ ...cardInput, id, parent: cardParentId(id), depth: cardDepth(id), children: [] });
  const parentNamespace = cardNamespace(projectRoot, cardInput.parent);
  const childrenPath = join(parentNamespace, 'children');
  try { mkdirSync(childrenPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; requireDirectory(childrenPath); }
  mkdirSync(cardNamespace(projectRoot, id));
  mkdirSync(join(cardNamespace(projectRoot, id), 'conversations'));
  publishInitialStreams(projectRoot, card, briefContent, writer, temporary);
  proveCreatedCardPublication(projectRoot, card);
  return card;
}

export function publishInitialProjectCard(projectRoot: string, card: CardRecord, briefContent: string, writer: 'analyst' | 'planner', temporary?: PublicationTemporaryIdFactory): void {
  cardRecordSchema.parse(card);
  if (card.id !== 'project' || card.children.length !== 0) throw new Error('Initial project card is invalid.');
  mkdirSync(cardNamespace(projectRoot, 'project'));
  mkdirSync(join(cardNamespace(projectRoot, 'project'), 'conversations'));
  mkdirSync(join(projectRoot, '.saivage', 'agents'));
  mkdirSync(join(projectRoot, '.saivage', 'agents', 'conversations'));
  publishInitialStreams(projectRoot, card, briefContent, writer, temporary);
}

export function publishCardVersion(projectRoot: string, card: CardRecord, history: CardHistoryEntry | null, io?: GrowingFileIo): CardVersionArtifact {
  cardRecordSchema.parse(card); if (history) cardHistoryEntrySchema.parse(history);
  const stream = readCardArtifacts(projectRoot, card.id);
  const current = stream.current.card;
  if (card.version_seq !== current.version_seq + 1) throw new Error(`Card '${card.id}' expected version ${current.version_seq + 1}.`);
  const row = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: card.version_seq, committed_at: new Date().toISOString(), card, history }, cardStreamFile(projectRoot, card.id), { cardId: card.id, version: card.version_seq });
  validateCardStream([...stream.rows, row], cardStreamFile(projectRoot, card.id), card.id);
  appendEnvelope(cardStreamFile(projectRoot, card.id), serializeGrowingEnvelope([row], cardStreamRowSchema), io);
  return row;
}

export function publishCardTombstone(projectRoot: string, cardId: string, finalCard: CardRecord, deletionHistory: CardHistoryEntry, io?: GrowingFileIo): CardTombstone {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.');
  const row: CardTombstone = { kind: 'card-tombstone', format_version: 1, card_id: cardId, deleted_at: deletionHistory.changed_at, final_card: finalCard, deletion_history: deletionHistory };
  cardStreamRowSchema.parse(row);
  const stream = readCardArtifacts(projectRoot, cardId);
  validateCardStream([...stream.rows, row], cardStreamFile(projectRoot, cardId), cardId);
  appendEnvelope(cardStreamFile(projectRoot, cardId), serializeGrowingEnvelope([row], cardStreamRowSchema), io);
  return row;
}
