import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  cardVersionEntrySchema,
  cardVersionIndexSchema,
  validateCardTransition,
  validateInitialCard,
  type CardArtifact,
  type CardTombstoneArtifact,
  type CardVersionArtifact,
  type CardVersionChange,
  type CardVersionEntry,
  type CardVersionIndex,
} from './canonical-card-artifacts.js';
import { type CanonicalGrowingFileSnapshot, type CanonicalReadInstrumentation, type GrowingFileIo } from './growing-file.js';
import { cardChildrenRoot, cardConversationsRoot, cardNamespace, cardRecordsRoot, cardStorageRoot, cardVersionFile, cardVersionIndexFile, cardVersionsRoot, globalAgentConversationsRoot, saivageAgentsRoot, saivageCardsRoot, saivageRoot } from './layout.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';
import { createImmutableVersionFile, serializeStrictJson, type ImmutableVersionFileIo } from './version-file.js';
import { versionFilename } from './version-index.js';

export interface CardArtifactIndex {
  readonly index: CardVersionIndex;
  readonly head: CardArtifact;
  readonly current: { readonly card: CardRecord; readonly committed_at: string };
  readonly tombstone: CardTombstoneArtifact | null;
  readonly snapshot: CanonicalGrowingFileSnapshot<CardArtifact>;
}

export interface CanonicalLinkedCardHistoryProjection {
  readonly current: CardRecord;
  readonly tombstone: CardTombstoneArtifact | null;
  readonly versions: readonly CardVersionEntry[];
}

export type CardTargetRead<T> = { readonly kind: 'found'; readonly value: T } | { readonly kind: 'card-not-found' };
export type HistoricalUnavailableReason = 'missing' | 'corrupt' | 'io_error';
export interface InitialProjectCardInput { readonly title: string; readonly bootstrap_content: string }
export type CardVersionRead = CardTargetRead<CardArtifact>
  | { readonly kind: 'version-not-found'; readonly version: number }
  | { readonly kind: 'historical-unavailable'; readonly version: number; readonly reason: HistoricalUnavailableReason };

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

function parseStrictJsonFile<T>(path: string, schema: { parse(value: unknown): T }, instrumentation?: CanonicalReadInstrumentation): { value: T; bytes: Buffer; modifiedAt: string } {
  instrumentation?.onRead(path);
  const bytes = readFileSync(path);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`Canonical JSON file '${path}' is malformed.`, { cause: error }); }
  if (text.length === 0 || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error(`Canonical JSON file '${path}' must contain one newline-terminated JSON object.`);
  try { return { value: schema.parse(JSON.parse(text.slice(0, -1))), bytes, modifiedAt: statSync(path).mtime.toISOString() }; }
  catch (error) { throw new Error(`Canonical JSON file '${path}' is malformed.`, { cause: error }); }
}

function readCardIndex(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardVersionIndex {
  const path = cardVersionIndexFile(projectRoot, cardId);
  const index = parseStrictJsonFile(path, cardVersionIndexSchema, instrumentation).value;
  if (index.card_id !== cardId) throw new Error(`Card index '${path}' has the wrong card identity.`);
  return index;
}

function artifactMatchesEntry(path: string, cardId: string, artifact: CardArtifact, entry: CardVersionEntry): void {
  if (artifact.card_id !== cardId || artifact.entry_id !== entry.entry_id || artifact.version !== entry.version || artifact.kind !== entry.artifact_kind || artifact.committed_at !== entry.committed_at || JSON.stringify(artifact.change) !== JSON.stringify(entry.change)) throw new Error(`Card artifact '${path}' does not match its index entry.`);
}

function readListedArtifact(projectRoot: string, cardId: string, entry: CardVersionEntry, instrumentation?: CanonicalReadInstrumentation): { artifact: CardArtifact; snapshot: CanonicalGrowingFileSnapshot<CardArtifact> } {
  const path = cardVersionFile(projectRoot, cardId, entry.filename);
  const parsed = parseStrictJsonFile(path, cardArtifactSchema, instrumentation);
  artifactMatchesEntry(path, cardId, parsed.value, entry);
  return { artifact: parsed.value, snapshot: Object.freeze({ bytes: parsed.bytes, rows: Object.freeze([parsed.value]), size: parsed.bytes.byteLength, modifiedAt: parsed.modifiedAt }) };
}

function readCurrentFromIndex(projectRoot: string, cardId: string, index: CardVersionIndex, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex {
  const entry = index.versions.at(-1);
  if (!entry) throw new Error(`Required card '${cardId}' has an empty version index.`);
  const { artifact: head, snapshot } = readListedArtifact(projectRoot, cardId, entry, instrumentation);
  const tombstone = head.kind === 'card-tombstone' ? head : null;
  const current = { card: head.kind === 'card-version' ? head.card : head.final_card, committed_at: head.committed_at };
  return { index, head, current, tombstone, snapshot };
}

function exactCurrent(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex {
  return readCurrentFromIndex(projectRoot, cardId, readCardIndex(projectRoot, cardId, instrumentation), instrumentation);
}

function proveCommittedCardIndexFromBase(realProjectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardVersionIndex | null {
  const segments = cardIdSegments(targetId);
  if (segments.length === 0) return readCardIndex(realProjectRoot, 'project', instrumentation);
  let currentId = 'project';
  let current = exactCurrent(realProjectRoot, currentId, instrumentation);
  if (current.tombstone) throw new Error('The project card cannot be tombstoned.');
  for (const [position, segment] of segments.entries()) {
    const nextId = childCardId(currentId, segment);
    if (!current.current.card.children.includes(nextId)) return null;
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, currentId));
    proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, nextId));
    if (position === segments.length - 1) return readCardIndex(realProjectRoot, nextId, instrumentation);
    current = exactCurrent(realProjectRoot, nextId, instrumentation);
    if (current.tombstone) return null;
    currentId = nextId;
  }
  throw new Error('Unreachable committed card path state.');
}

function proveActiveCardPathFromBase(realProjectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex | null {
  const segments = cardIdSegments(targetId); let currentId = 'project'; let current = exactCurrent(realProjectRoot, currentId, instrumentation);
  if (current.tombstone) throw new Error('The project card cannot be tombstoned.');
  for (const segment of segments) {
    const nextId = childCardId(currentId, segment); if (!current.current.card.children.includes(nextId)) return null;
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, currentId)); proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, nextId));
    current = exactCurrent(realProjectRoot, nextId, instrumentation); if (current.tombstone) return null; currentId = nextId;
  }
  return current;
}

function proveActiveCardPathWithRoot(projectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): { realProjectRoot: string; target: CardArtifactIndex } | null {
  cardIdSchema.parse(targetId);
  const realProjectRoot = proveCanonicalBase(projectRoot);
  if (realProjectRoot === null) return null;
  const target = proveActiveCardPathFromBase(realProjectRoot, targetId, instrumentation);
  return target ? { realProjectRoot, target } : null;
}

export function proveActiveCardPath(projectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex | null { return proveActiveCardPathWithRoot(projectRoot, targetId, instrumentation)?.target ?? null; }
export function readCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord | null { return proveActiveCardPath(projectRoot, cardId, instrumentation)?.current.card ?? null; }
export function readCardDetail(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> { const target = proveActiveCardPath(projectRoot, cardId, instrumentation); return target ? { kind: 'found', value: target.current.card } : { kind: 'card-not-found' }; }

export interface LinkedChildrenProjection { readonly parent: CardRecord; readonly activeChildren: CardRecord[] }
export interface CanonicalCardProjection { readonly card: CardRecord; readonly snapshot: CanonicalGrowingFileSnapshot<CardArtifact> }
export interface CanonicalLinkedChildrenProjection { readonly parent: CanonicalCardProjection; readonly activeChildren: CanonicalCardProjection[] }
export type CanonicalCardFileSlot = 'card' | RecordName;
export interface CanonicalCardFileMetadata { readonly slot: CanonicalCardFileSlot; readonly size: number; readonly modifiedAt: string }
export interface CanonicalCardFilesMetadataProjection { readonly card: CanonicalCardProjection; readonly files: readonly CanonicalCardFileMetadata[] }
export type CanonicalCardFileContentRead = CardTargetRead<{ readonly card: CardRecord; readonly slot: CanonicalCardFileSlot; readonly snapshot: CanonicalGrowingFileSnapshot<unknown> }> | { readonly kind: 'slot-not-found' } | { readonly kind: 'too-large'; readonly size: number };

function canonicalProjection(index: CardArtifactIndex): CanonicalCardProjection { return { card: index.current.card, snapshot: index.snapshot }; }
function readCanonicalChildrenOfReached(realProjectRoot: string, parentId: string, parent: CardArtifactIndex, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex[] {
  const active: CardArtifactIndex[] = [];
  for (const id of parent.current.card.children) {
    const segment = cardIdSegments(id).at(-1)!;
    if (childCardId(parentId, segment) !== id) throw new Error(`Card '${parentId}' has invalid direct child '${id}'.`);
    proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, parentId));
    proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, id));
    const child = exactCurrent(realProjectRoot, id, instrumentation);
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
  const files: CanonicalCardFileMetadata[] = [{ slot: 'card', size: reached.target.snapshot.size, modifiedAt: reached.target.snapshot.modifiedAt }];
  for (const definition of definitions) {
    const record = readCurrentAuthoredRecord(reached.realProjectRoot, cardId, definition); if (!record) continue;
    const effective = record.artifact.state === 'open' ? record.artifact.draft : record.artifact.accepted;
    if (!effective) continue;
    files.push({ slot: definition.filename, size: Buffer.byteLength(effective.content), modifiedAt: record.artifact.state === 'open' ? record.artifact.draft!.updated_at : record.artifact.accepted!.committed_at });
  }
  return { kind: 'found', value: { card: canonicalProjection(reached.target), files } };
}
export function readCanonicalCardFileContent(projectRoot: string, cardId: string, slot: CanonicalCardFileSlot, maximumBytes: number, definitions: readonly RecordDefinition[]): CanonicalCardFileContentRead {
  const reached = proveActiveCardPathWithRoot(projectRoot, cardId); if (!reached) return { kind: 'card-not-found' };
  if (slot === 'card') return reached.target.snapshot.size > maximumBytes ? { kind: 'too-large', size: reached.target.snapshot.size } : { kind: 'found', value: { card: reached.target.current.card, slot, snapshot: reached.target.snapshot } };
  const definition = definitions.find((value) => value.filename === slot); if (!definition) return { kind: 'slot-not-found' };
  const record = readCurrentAuthoredRecord(reached.realProjectRoot, cardId, definition); if (!record) return { kind: 'slot-not-found' };
  const effective = record.artifact.state === 'open' ? record.artifact.draft : record.artifact.accepted; if (!effective) return { kind: 'slot-not-found' };
  const bytes = Buffer.from(effective.content); if (bytes.byteLength > maximumBytes) return { kind: 'too-large', size: bytes.byteLength };
  return { kind: 'found', value: { card: reached.target.current.card, slot, snapshot: Object.freeze({ bytes, rows: Object.freeze([record.artifact]), size: bytes.byteLength, modifiedAt: record.artifact.state === 'open' ? record.artifact.draft!.updated_at : record.artifact.accepted!.committed_at }) } };
}

export function readCardHierarchy(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<LinkedChildrenProjection> { const result = readCanonicalCardHierarchy(projectRoot, parentId, instrumentation); return result.kind === 'card-not-found' ? result : { kind: 'found', value: { parent: result.value.parent.card, activeChildren: result.value.activeChildren.map(({ card }) => card) } }; }
export function readLinkedChildrenProjection(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): LinkedChildrenProjection { const result = readCardHierarchy(projectRoot, parentId, instrumentation); if (result.kind === 'card-not-found') throw new Error(`Parent card '${parentId}' does not exist.`); return result.value; }
export function readLinkedChildren(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord[] { return readLinkedChildrenProjection(projectRoot, parentId, instrumentation).activeChildren; }
export function readCardArtifacts(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex { const artifacts = proveActiveCardPath(projectRoot, cardId, instrumentation); if (!artifacts) throw new Error(`Card '${cardId}' does not exist.`); return artifacts; }

export function listCards(projectRoot: string): CardRecord[] {
  const realProjectRoot = proveCanonicalBase(projectRoot); if (!realProjectRoot) return [];
  const root = exactCurrent(realProjectRoot, 'project'); if (root.tombstone) throw new Error('The project card cannot be tombstoned.');
  const cards: CardRecord[] = []; const visit = (artifacts: CardArtifactIndex): void => { cards.push(artifacts.current.card); for (const child of readCanonicalChildrenOfReached(realProjectRoot, artifacts.current.card.id, artifacts)) visit(child); };
  visit(root); validateParsedCards({ cards }); return cards;
}

export function readCanonicalLinkedCardHistoryTree(projectRoot: string, instrumentation?: CanonicalReadInstrumentation): readonly CanonicalLinkedCardHistoryProjection[] {
  const realProjectRoot = proveCanonicalBase(projectRoot); if (!realProjectRoot) return [];
  const reached: CanonicalLinkedCardHistoryProjection[] = [];
  const visit = (cardId: string, current: CardArtifactIndex): void => {
    reached.push(Object.freeze({ current: current.current.card, tombstone: current.tombstone, versions: Object.freeze([...current.index.versions]) }));
    if (current.tombstone) return;
    for (const childId of current.current.card.children) { proveCanonicalDirectory(realProjectRoot, cardChildrenRoot(realProjectRoot, cardId)); proveCanonicalDirectory(realProjectRoot, cardNamespace(realProjectRoot, childId)); visit(childId, exactCurrent(realProjectRoot, childId, instrumentation)); }
  };
  visit('project', exactCurrent(realProjectRoot, 'project', instrumentation)); return Object.freeze(reached);
}

export function listCardVersions(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<readonly CardVersionEntry[]> {
  cardIdSchema.parse(cardId); const root = proveCanonicalBase(projectRoot); if (!root) return { kind: 'card-not-found' };
  const index = proveCommittedCardIndexFromBase(root, cardId, instrumentation); return index ? { kind: 'found', value: index.versions } : { kind: 'card-not-found' };
}

export function readCardVersion(projectRoot: string, cardId: string, version: number, instrumentation?: CanonicalReadInstrumentation): CardVersionRead {
  const listed = listCardVersions(projectRoot, cardId, instrumentation); if (listed.kind === 'card-not-found') return listed;
  const entry = listed.value.find((candidate) => candidate.version === version); if (!entry) return { kind: 'version-not-found', version };
  try { return { kind: 'found', value: readListedArtifact(projectRoot, cardId, entry, instrumentation).artifact }; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return { kind: 'historical-unavailable', version, reason: code === 'ENOENT' ? 'missing' : code ? 'io_error' : 'corrupt' }; }
}

export function readCurrentCardArtifact(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardArtifact> {
  cardIdSchema.parse(cardId); const root = proveCanonicalBase(projectRoot); if (!root) return { kind: 'card-not-found' };
  const index = proveCommittedCardIndexFromBase(root, cardId, instrumentation); if (!index) return { kind: 'card-not-found' };
  const entry = index.versions.at(-1); if (!entry) throw new Error(`Required card '${cardId}' has an empty version index.`);
  return { kind: 'found', value: readListedArtifact(root, cardId, entry, instrumentation).artifact };
}

export type CardDiffValue = { readonly deleted: boolean; readonly card: CardRecord };
export function cardDiffValue(artifact: CardArtifact): CardDiffValue { return artifact.kind === 'card-version' ? { deleted: false, card: artifact.card } : { deleted: true, card: artifact.final_card }; }

function emptyCardIndex(cardId: string): CardVersionIndex { return cardVersionIndexSchema.parse({ format_version: 1, kind: 'card-version-index', card_id: cardId, versions: [], current_version: null, current_filename: null }); }
function publishIndex(path: string, index: CardVersionIndex, temporary?: PublicationTemporaryIdFactory): void { replaceFile(path, serializeStrictJson(cardVersionIndexSchema.parse(index)), temporary); }

function publishInitialStreams(projectRoot: string, card: CardRecord, bootstrapContent: string, definitions: readonly RecordDefinition[], temporary?: PublicationTemporaryIdFactory): void {
  mkdirSync(cardStorageRoot(projectRoot, card.id)); mkdirSync(cardVersionsRoot(projectRoot, card.id));
  publishIndex(cardVersionIndexFile(projectRoot, card.id), emptyCardIndex(card.id), temporary);
  mkdirSync(cardRecordsRoot(projectRoot, card.id));
  for (const definition of definitions) initializeAuthoredRecord(projectRoot, card.id, definition, definition.bootstrap ? bootstrapContent : undefined, temporary);
  validateInitialCard(card, cardVersionIndexFile(projectRoot, card.id));
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

function entryFor(artifact: CardArtifact, filename: string): CardVersionEntry { return cardVersionEntrySchema.parse({ entry_id: artifact.entry_id, version: artifact.version, filename, artifact_kind: artifact.kind, committed_at: artifact.committed_at, change: artifact.change }); }

export function publishCardVersion(projectRoot: string, card: CardRecord, change: CardVersionChange | null, io?: ImmutableVersionFileIo | GrowingFileIo, temporary?: PublicationTemporaryIdFactory): CardVersionArtifact {
  const index = readCardIndex(projectRoot, card.id); const priorEntry = index.versions.at(-1); const version = priorEntry ? priorEntry.version + 1 : 1;
  if (index.versions.some((entry) => entry.artifact_kind === 'card-tombstone')) throw new Error(`Card '${card.id}' is terminal.`);
  const entryId = change?.entry_id ?? randomUUID(); const committedAt = change?.changed_at ?? card.created_at;
  const artifact = cardVersionArtifactSchema.parse({ format_version: 1, kind: 'card-version', entry_id: entryId, card_id: card.id, version, committed_at: committedAt, card, change });
  if (version === 1) validateInitialCard(artifact.card, cardVersionIndexFile(projectRoot, card.id));
  else { const current = readCurrentFromIndex(projectRoot, card.id, index); if (current.tombstone) throw new Error(`Card '${card.id}' is terminal.`); validateCardTransition(current.current.card, artifact.card, artifact.change!, cardVersionIndexFile(projectRoot, card.id)); }
  const filename = versionFilename(version, randomUUID(), 'json'); const entry = entryFor(artifact, filename);
  const next = cardVersionIndexSchema.parse({ ...index, versions: [...index.versions, entry], current_version: version, current_filename: filename });
  createImmutableVersionFile(cardVersionFile(projectRoot, card.id, filename), serializeStrictJson(artifact), io as ImmutableVersionFileIo | undefined);
  publishIndex(cardVersionIndexFile(projectRoot, card.id), next, temporary); return artifact;
}

export function publishCardTombstone(projectRoot: string, cardId: string, finalCard: CardRecord, change: CardVersionChange, io?: ImmutableVersionFileIo | GrowingFileIo, temporary?: PublicationTemporaryIdFactory): CardTombstoneArtifact {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.'); const current = readCardArtifacts(projectRoot, cardId); const index = current.index; const version = index.versions.length + 1;
  if (JSON.stringify(current.current.card) !== JSON.stringify(finalCard)) throw new Error(`Card '${cardId}' tombstone final card must equal current.`);
  const artifact = cardTombstoneArtifactSchema.parse({ format_version: 1, kind: 'card-tombstone', entry_id: change.entry_id, card_id: cardId, version, committed_at: change.changed_at, prior_card_version: finalCard.version_seq, final_card: finalCard, change });
  const filename = versionFilename(version, randomUUID(), 'json'); const entry = entryFor(artifact, filename); const next = cardVersionIndexSchema.parse({ ...index, versions: [...index.versions, entry], current_version: version, current_filename: filename });
  createImmutableVersionFile(cardVersionFile(projectRoot, cardId, filename), serializeStrictJson(artifact), io as ImmutableVersionFileIo | undefined); publishIndex(cardVersionIndexFile(projectRoot, cardId), next, temporary); return artifact;
}
