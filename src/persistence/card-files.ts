import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { validateParsedCards } from '../cards/validator.js';
import type { NewChildCardInput } from '../cards/lifecycle.js';
import { cardIdSchema, cardIdSegments, cardParentId, childCardId, nextCardSegment } from '../schemas/card-id.js';
import { cardAgentSessionId, cardRecordSchema, type AgentName, type CardRecord, type RecordName } from '../schemas/index.js';
import type { RecordDefinition } from '../records/record-definition.js';
import type { CompiledCardTypeWorkflow } from '../runtime/card-process/card-process-config.js';
import { initializeAuthoredRecord, readCurrentAuthoredRecord } from './authored-record-files.js';
import { initializeConversation } from './conversation-file.js';
import {
  cardArtifactSchema,
  cardTombstoneArtifactSchema,
  cardVersionArtifactSchema,
  cardVersionListEntry,
  validateCardStream,
  validateInitialCard,
  validateCardTransition,
  type CardArtifact,
  type CardStreamFold,
  type CardTombstoneArtifact,
  type CardVersionArtifact,
  type CardVersionChange,
  type CardVersionListEntry,
} from './canonical-card-artifacts.js';
import { appendEnvelope, publishFirstEnvelope, readStrictCanonicalGrowingFile, serializeGrowingEnvelope, type CanonicalReadInstrumentation, type GrowingFileIo } from './growing-file.js';
import { cardChildrenRoot, cardConversationsRoot, cardNamespace, cardStreamFile, globalAgentConversationsRoot, saivageAgentsRoot, saivageCardsRoot, saivageRoot } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface CanonicalLinkedCardHistoryProjection {
  readonly current: CardRecord;
  readonly tombstone: CardTombstoneArtifact | null;
  readonly rows: readonly CardArtifact[];
}

export type CardTargetRead<T> = { readonly kind: 'found'; readonly value: T } | { readonly kind: 'card-not-found' };
export interface InitialProjectCardInput { readonly title: string; readonly bootstrap_content: string }
export type CardVersionRead = CardTargetRead<CardArtifact> | { readonly kind: 'version-not-found'; readonly version: number };

function requireDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Canonical card path '${path}' must be a real directory.`);
}

function proveCanonicalDirectory(realProjectRoot: string, path: string): void {
  requireDirectory(path);
  const real = realpathSync(path);
  const fromRoot = relative(realProjectRoot, real);
  if (real !== path || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Canonical card path '${path}' must resolve to its exact contained directory.`);
}

function proveCanonicalBase(projectRoot: string): string | null {
  const configuredRoot = resolve(projectRoot);
  const realProjectRoot = realpathSync(configuredRoot);
  requireDirectory(realProjectRoot);
  try {
    proveCanonicalDirectory(realProjectRoot, saivageRoot(realProjectRoot));
    proveCanonicalDirectory(realProjectRoot, saivageCardsRoot(realProjectRoot));
    proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, 'project'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return realProjectRoot;
}

function readExactCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardStreamFold {
  const path = cardStreamFile(projectRoot, cardId);
  return validateCardStream(readStrictCanonicalGrowingFile(path, cardArtifactSchema, instrumentation), path, cardId);
}

function proveCommittedCardFoldFromBase(realProjectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardStreamFold | null {
  const segments = cardIdSegments(targetId);
  if (segments.length === 0) return readExactCard(realProjectRoot, 'project', instrumentation);
  let currentId = 'project';
  let current = readExactCard(realProjectRoot, currentId, instrumentation);
  if (current.tombstone) throw new Error('The project card cannot be tombstoned.');
  for (const [position, segment] of segments.entries()) {
    const nextId = childCardId(currentId, segment);
    if (!current.current.card.children.includes(nextId)) return null;
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, currentId));
    proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, nextId));
    if (position === segments.length - 1) return readExactCard(realProjectRoot, nextId, instrumentation);
    current = readExactCard(realProjectRoot, nextId, instrumentation);
    if (current.tombstone) return null;
    currentId = nextId;
  }
  throw new Error('Unreachable committed card path state.');
}

function proveActiveCardPathFromBase(realProjectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardStreamFold | null {
  const segments = cardIdSegments(targetId); let currentId = 'project'; let current = readExactCard(realProjectRoot, currentId, instrumentation);
  if (current.tombstone) throw new Error('The project card cannot be tombstoned.');
  for (const segment of segments) {
    const nextId = childCardId(currentId, segment); if (!current.current.card.children.includes(nextId)) return null;
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, currentId)); proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, nextId));
    current = readExactCard(realProjectRoot, nextId, instrumentation); if (current.tombstone) return null; currentId = nextId;
  }
  return current;
}

function proveActiveCardPathWithRoot(projectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): { realProjectRoot: string; target: CardStreamFold } | null {
  cardIdSchema.parse(targetId);
  const realProjectRoot = proveCanonicalBase(projectRoot);
  if (realProjectRoot === null) return null;
  const target = proveActiveCardPathFromBase(realProjectRoot, targetId, instrumentation);
  return target ? { realProjectRoot, target } : null;
}

export function proveActiveCardPath(projectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardStreamFold | null { return proveActiveCardPathWithRoot(projectRoot, targetId, instrumentation)?.target ?? null; }
export function readCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord | null { return proveActiveCardPath(projectRoot, cardId, instrumentation)?.current.card ?? null; }
export function readCardDetail(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> { const target = proveActiveCardPath(projectRoot, cardId, instrumentation); return target ? { kind: 'found', value: target.current.card } : { kind: 'card-not-found' }; }

export interface LinkedChildrenProjection { readonly parent: CardRecord; readonly activeChildren: CardRecord[] }
export interface CanonicalCardProjection { readonly card: CardRecord; readonly artifact: CardArtifact }
export interface CanonicalLinkedChildrenProjection { readonly parent: CanonicalCardProjection; readonly activeChildren: CanonicalCardProjection[] }
export type CanonicalCardFileSlot = 'card' | RecordName;
export interface CanonicalCardRecordFileMetadata { readonly slot: RecordName; readonly size: number; readonly modifiedAt: string }
export interface CanonicalCardFilesMetadataProjection { readonly card: CanonicalCardProjection; readonly recordFiles: readonly CanonicalCardRecordFileMetadata[] }

function canonicalProjection(fold: CardStreamFold): CanonicalCardProjection { return { card: fold.current.card, artifact: fold.head }; }
function readCanonicalChildrenOfReached(realProjectRoot: string, parentId: string, parent: CardStreamFold, instrumentation?: CanonicalReadInstrumentation): CardStreamFold[] {
  const active: CardStreamFold[] = [];
  for (const id of parent.current.card.children) {
    const segment = cardIdSegments(id).at(-1)!;
    if (childCardId(parentId, segment) !== id) throw new Error(`Card '${parentId}' has invalid direct child '${id}'.`);
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, parentId));
    proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, id));
    const child = readExactCard(realProjectRoot, id, instrumentation);
    if (!child.tombstone) active.push(child);
  }
  return active;
}

export function readCanonicalCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardProjection> { const target = proveActiveCardPath(projectRoot, cardId, instrumentation); return target ? { kind: 'found', value: canonicalProjection(target) } : { kind: 'card-not-found' }; }
export function readCanonicalCardHierarchy(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalLinkedChildrenProjection> {
  cardIdSchema.parse(parentId); const realProjectRoot = proveCanonicalBase(projectRoot); if (!realProjectRoot) return { kind: 'card-not-found' };
  const target = proveActiveCardPathFromBase(realProjectRoot, parentId, instrumentation); if (!target) return { kind: 'card-not-found' };
  return { kind: 'found', value: { parent: canonicalProjection(target), activeChildren: readCanonicalChildrenOfReached(realProjectRoot, parentId, target, instrumentation).map(canonicalProjection) } };
}

export function readCanonicalCardFilesMetadata(projectRoot: string, cardId: string, definitions: readonly RecordDefinition[]): CardTargetRead<CanonicalCardFilesMetadataProjection> {
  const reached = proveActiveCardPathWithRoot(projectRoot, cardId); if (!reached) return { kind: 'card-not-found' };
  const recordFiles: CanonicalCardRecordFileMetadata[] = [];
  for (const definition of definitions) {
    const record = readCurrentAuthoredRecord(reached.realProjectRoot, cardId, definition); if (!record) continue;
    const effective = record.artifact.state === 'open' ? record.artifact.draft : record.artifact.accepted;
    if (!effective) continue;
    recordFiles.push({ slot: definition.filename, size: Buffer.byteLength(effective.content), modifiedAt: record.artifact.state === 'open' ? record.artifact.draft!.updated_at : record.artifact.accepted!.committed_at });
  }
  return { kind: 'found', value: { card: canonicalProjection(reached.target), recordFiles } };
}

export function readCardHierarchy(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<LinkedChildrenProjection> { const result = readCanonicalCardHierarchy(projectRoot, parentId, instrumentation); return result.kind === 'card-not-found' ? result : { kind: 'found', value: { parent: result.value.parent.card, activeChildren: result.value.activeChildren.map(({ card }) => card) } }; }
export function readLinkedChildrenProjection(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): LinkedChildrenProjection { const result = readCardHierarchy(projectRoot, parentId, instrumentation); if (result.kind === 'card-not-found') throw new Error(`Parent card '${parentId}' does not exist.`); return result.value; }
export function readLinkedChildren(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord[] { return readLinkedChildrenProjection(projectRoot, parentId, instrumentation).activeChildren; }
export function readCardArtifacts(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardStreamFold { const fold = proveActiveCardPath(projectRoot, cardId, instrumentation); if (!fold) throw new Error(`Card '${cardId}' does not exist.`); return fold; }

export function listCards(projectRoot: string): CardRecord[] {
  const realProjectRoot = proveCanonicalBase(projectRoot); if (!realProjectRoot) return [];
  const root = readExactCard(realProjectRoot, 'project'); if (root.tombstone) throw new Error('The project card cannot be tombstoned.');
  const cards: CardRecord[] = []; const visit = (fold: CardStreamFold): void => { cards.push(fold.current.card); for (const child of readCanonicalChildrenOfReached(realProjectRoot, fold.current.card.id, fold)) visit(child); };
  visit(root); validateParsedCards({ cards }); return cards;
}

export function readCanonicalLinkedCardHistoryTree(projectRoot: string, instrumentation?: CanonicalReadInstrumentation): readonly CanonicalLinkedCardHistoryProjection[] {
  const realProjectRoot = proveCanonicalBase(projectRoot); if (!realProjectRoot) return [];
  const reached: CanonicalLinkedCardHistoryProjection[] = [];
  const visit = (cardId: string, current: CardStreamFold): void => {
    reached.push(Object.freeze({ current: current.current.card, tombstone: current.tombstone, rows: current.rows }));
    if (current.tombstone) return;
    for (const childId of current.current.card.children) { proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, cardId)); proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, childId)); visit(childId, readExactCard(realProjectRoot, childId, instrumentation)); }
  };
  visit('project', readExactCard(realProjectRoot, 'project', instrumentation)); return Object.freeze(reached);
}

export function listCardVersions(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<readonly CardVersionListEntry[]> {
  cardIdSchema.parse(cardId); const root = proveCanonicalBase(projectRoot); if (!root) return { kind: 'card-not-found' };
  const fold = proveCommittedCardFoldFromBase(root, cardId, instrumentation); return fold ? { kind: 'found', value: fold.rows.map(cardVersionListEntry) } : { kind: 'card-not-found' };
}

export function readCardVersion(projectRoot: string, cardId: string, version: number, instrumentation?: CanonicalReadInstrumentation): CardVersionRead {
  cardIdSchema.parse(cardId); const root = proveCanonicalBase(projectRoot); if (!root) return { kind: 'card-not-found' };
  const fold = proveCommittedCardFoldFromBase(root, cardId, instrumentation); if (!fold) return { kind: 'card-not-found' };
  const row = fold.rows[version - 1];
  return row && row.version === version ? { kind: 'found', value: row } : { kind: 'version-not-found', version };
}

export function readCurrentCardArtifact(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardArtifact> {
  cardIdSchema.parse(cardId); const root = proveCanonicalBase(projectRoot); if (!root) return { kind: 'card-not-found' };
  const fold = proveCommittedCardFoldFromBase(root, cardId, instrumentation); return fold ? { kind: 'found', value: fold.head } : { kind: 'card-not-found' };
}

export type CardDiffValue = { readonly deleted: boolean; readonly card: CardRecord };
export function cardDiffValue(artifact: CardArtifact): CardDiffValue { return artifact.kind === 'card-version' ? { deleted: false, card: artifact.card } : { deleted: true, card: artifact.final_card }; }

function appendCardRow(path: string, artifact: CardArtifact, io?: GrowingFileIo): void {
  const result = appendEnvelope(path, serializeGrowingEnvelope([artifact], cardArtifactSchema), io);
  if (result.kind === 'missing') throw new Error(`Card stream '${path}' is missing for append.`);
}

function publishInitialStreams(projectRoot: string, card: CardRecord, bootstrapContent: string, definitions: readonly RecordDefinition[], temporary?: PublicationTemporaryIdFactory): void {
  for (const definition of definitions) initializeAuthoredRecord(projectRoot, card.id, definition, definition.bootstrap ? bootstrapContent : undefined, temporary);
  validateInitialCard(card, cardStreamFile(projectRoot, card.id));
  publishCardVersion(projectRoot, card, null, undefined, temporary);
}

function initializeCardConversations(projectRoot: string, card: CardRecord, workflow: CompiledCardTypeWorkflow, temporary?: PublicationTemporaryIdFactory): void {
  const names = new Set<AgentName>();
  for (const state of workflow.states.values()) if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
  for (const name of names) initializeConversation(projectRoot, cardAgentSessionId(name, card.id), temporary);
}

function claimChildNamespace(projectRoot: string, parentId: string): string { const childrenPath = cardChildrenRoot(projectRoot, parentId); try { mkdirSync(childrenPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; requireDirectory(childrenPath); } let segment = nextCardSegment(); for (;;) { const id = childCardId(parentId, segment); try { mkdirSync(cardNamespace(projectRoot, id)); return id; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; segment = nextCardSegment(segment); } } }

export function publishInitialChildCard(projectRoot: string, input: NewChildCardInput, workflow: CompiledCardTypeWorkflow, temporary?: PublicationTemporaryIdFactory): CardRecord {
  if (workflow.cardType !== input.type) throw new Error(`Compiled workflow '${workflow.cardType}' does not match child type '${input.type}'.`);
  const id = claimChildNamespace(projectRoot, input.parent); if (cardParentId(id) !== input.parent) throw new Error(`Claimed card '${id}' does not belong to requested parent '${input.parent}'.`);
  const stamp = new Date().toISOString(); const card = cardRecordSchema.parse({ id, type: input.type, children: [], title: input.title, subtype: null, tags: input.tags, priority: input.priority, urgency: input.urgency, created_by: input.created_by, created_at: stamp, updated_at: stamp, version_seq: 1, assigned_to: null, depends_on: input.depends_on, related: input.related, lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] });
  const definitions = [...workflow.records.values()].map((record): RecordDefinition => ({ filename: record.name, format: record.format, schema: record.schema, bootstrap: record.bootstrap,declared:true }));
  mkdirSync(cardConversationsRoot(projectRoot, id)); initializeCardConversations(projectRoot, card, workflow, temporary); publishInitialStreams(projectRoot, card, input.bootstrap_content, definitions, temporary); return card;
}

export function publishInitialProjectCard(projectRoot: string, input: InitialProjectCardInput, workflow: CompiledCardTypeWorkflow, temporary?: PublicationTemporaryIdFactory): void {
  if (workflow.cardType !== 'project') throw new Error('Initial project publication requires the compiled project workflow.'); if (input.bootstrap_content.trim().length === 0) throw new Error('Project bootstrap_content must contain non-whitespace Markdown.');
  const stamp = new Date().toISOString(); const card = cardRecordSchema.parse({ id: 'project', type: 'project', children: [], title: input.title, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'runtime:bootstrap', created_at: stamp, updated_at: stamp, version_seq: 1, assigned_to: null, depends_on: [], related: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] });
  const definitions = [...workflow.records.values()].map((record): RecordDefinition => ({ filename: record.name, format: record.format, schema: record.schema, bootstrap: record.bootstrap,declared:true }));
  mkdirSync(cardNamespace(projectRoot, 'project')); mkdirSync(cardConversationsRoot(projectRoot, 'project')); mkdirSync(saivageAgentsRoot(projectRoot)); mkdirSync(globalAgentConversationsRoot(projectRoot)); initializeCardConversations(projectRoot, card, workflow, temporary); publishInitialStreams(projectRoot, card, input.bootstrap_content, definitions, temporary);
}

export function publishCardVersion(projectRoot: string, card: CardRecord, change: CardVersionChange | null, io?: GrowingFileIo, temporary?: PublicationTemporaryIdFactory): CardVersionArtifact {
  const path = cardStreamFile(projectRoot, card.id);
  if (change === null) {
    const artifact = cardVersionArtifactSchema.parse({ format_version: 1, kind: 'card-version', entry_id: randomUUID(), card_id: card.id, version: 1, committed_at: card.created_at, card, change: null });
    validateInitialCard(artifact.card, path);
    publishFirstEnvelope(path, serializeGrowingEnvelope([artifact], cardArtifactSchema), temporary);
    return artifact;
  }
  const fold = validateCardStream(readStrictCanonicalGrowingFile(path, cardArtifactSchema), path, card.id);
  if (fold.tombstone) throw new Error(`Card '${card.id}' is terminal.`);
  const artifact = cardVersionArtifactSchema.parse({ format_version: 1, kind: 'card-version', entry_id: change.entry_id, card_id: card.id, version: fold.head.version + 1, committed_at: change.changed_at, card, change });
  validateCardTransition(fold.current.card, artifact.card, artifact.change!, path);
  appendCardRow(path, artifact, io); return artifact;
}

export function publishCardTombstone(projectRoot: string, cardId: string, finalCard: CardRecord, change: CardVersionChange, io?: GrowingFileIo): CardTombstoneArtifact {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.'); const fold = readCardArtifacts(projectRoot, cardId);
  if (fold.tombstone) throw new Error(`Card '${cardId}' is terminal.`);
  if (JSON.stringify(fold.current.card) !== JSON.stringify(finalCard)) throw new Error(`Card '${cardId}' tombstone final card must equal current.`);
  const artifact = cardTombstoneArtifactSchema.parse({ format_version: 1, kind: 'card-tombstone', entry_id: change.entry_id, card_id: cardId, version: fold.head.version + 1, committed_at: change.changed_at, prior_card_version: finalCard.version_seq, final_card: finalCard, change });
  appendCardRow(cardStreamFile(projectRoot, cardId), artifact, io); return artifact;
}
