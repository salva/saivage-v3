import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cardIdSchema, cardIdSegments, cardParentId, childCardId, nextCardSegment } from '../schemas/card-id.js';
import { cardRecordSchema, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { cardStreamRowSchema, validateCardStream, type CardTombstone, type CardVersionArtifact } from './canonical-card-artifacts.js';
import { recordVersionArtifactSchema, validateRecordStream } from './canonical-record-artifacts.js';
import { appendEnvelope, parseGrowingFile, prepareGrowingEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, readCanonicalGrowingFileSnapshot, serializeGrowingEnvelope, type CanonicalGrowingFileSnapshot, type CanonicalReadInstrumentation, type GrowingFileIo } from './growing-file.js';
import { cardNamespace, cardRecordStreamFile, cardStreamFile, saivageCardsRoot, saivageRoot } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';
import { validateParsedCards } from '../cards/validator.js';
import type { NewChildCardInput } from '../cards/lifecycle.js';
import type { NewProjectRootInput } from '../boot/app.js';
import type { RecordDefinition } from '../records/record-definition.js';
import type { RecordName } from '../schemas/index.js';
import type { CompiledCardTypeWorkflow } from '../runtime/card-process/card-process-config.js';

export interface CardArtifactIndex { readonly artifacts: CardVersionArtifact[]; readonly current: CardVersionArtifact; readonly tombstone: CardTombstone | null; readonly snapshot: CanonicalGrowingFileSnapshot<CardVersionArtifact | CardTombstone> }

function requireDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Canonical card path '${path}' must be a real directory.`);
}

function proveCanonicalDirectory(realProjectRoot: string, path: string): void {
  requireDirectory(path);
  const real = realpathSync(path);
  const fromRoot = relative(realProjectRoot, real);
  if (real !== path || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Canonical card path '${path}' must resolve to its exact contained directory.`);
  }
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

function exactStream(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex {
  const path = cardStreamFile(projectRoot, cardId);
  const snapshot = readCanonicalGrowingFileSnapshot(path, cardStreamRowSchema, undefined, instrumentation);
  return { ...validateCardStream([...snapshot.rows], path, cardId), snapshot };
}

export type CardTargetRead<T> = { readonly kind: 'found'; readonly value: T } | { readonly kind: 'card-not-found' };
export type CardHistoryEntryRead = CardTargetRead<CardHistoryEntry> | { readonly kind: 'history-entry-not-found'; readonly versionSeq: number };

function proveActiveCardPathFromBase(realProjectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex | null {
  const segments = cardIdSegments(targetId);
  let currentId = 'project';
  let namespace = cardNamespace(realProjectRoot, currentId);
  let artifacts = exactStream(realProjectRoot, currentId, instrumentation);
  if (artifacts.tombstone) throw new Error('The project card cannot be tombstoned.');
  for (const segment of segments) {
    const nextId = childCardId(currentId, segment);
    if (!artifacts.current.card.children.includes(nextId)) return null;
    const childrenPath = join(namespace, 'children');
    proveCanonicalDirectory(realProjectRoot, childrenPath);
    namespace = join(childrenPath, segment);
    proveCanonicalDirectory(realProjectRoot, namespace);
    artifacts = exactStream(realProjectRoot, nextId, instrumentation);
    if (artifacts.tombstone) return null;
    currentId = nextId;
  }
  return artifacts;
}

function proveActiveCardPathWithRoot(
  projectRoot: string,
  targetId: string,
  instrumentation?: CanonicalReadInstrumentation,
): { readonly realProjectRoot: string; readonly target: CardArtifactIndex } | null {
  cardIdSchema.parse(targetId);
  const realProjectRoot = proveCanonicalBase(projectRoot);
  if (realProjectRoot === null) return null;
  const target = proveActiveCardPathFromBase(realProjectRoot, targetId, instrumentation);
  return target ? { realProjectRoot, target } : null;
}

export function proveActiveCardPath(projectRoot: string, targetId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex | null {
  return proveActiveCardPathWithRoot(projectRoot, targetId, instrumentation)?.target ?? null;
}

export function readCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord | null { return proveActiveCardPath(projectRoot, cardId, instrumentation)?.current.card ?? null; }
export function readCardDetail(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> {
  const target = proveActiveCardPath(projectRoot, cardId, instrumentation);
  return target ? { kind: 'found', value: target.current.card } : { kind: 'card-not-found' };
}
export interface LinkedChildrenProjection { readonly parent: CardRecord; readonly activeChildren: CardRecord[] }
export interface CanonicalCardProjection { readonly card: CardRecord; readonly snapshot: CanonicalGrowingFileSnapshot<CardVersionArtifact | CardTombstone> }
export interface CanonicalLinkedChildrenProjection { readonly parent: CanonicalCardProjection; readonly activeChildren: CanonicalCardProjection[] }
export type CanonicalCardFileSlot = 'card' | RecordName;
export interface CanonicalCardFileMetadata {
  readonly slot: CanonicalCardFileSlot;
  readonly size: number;
  readonly modifiedAt: string;
}
export interface CanonicalCardFilesMetadataProjection {
  readonly card: CanonicalCardProjection;
  readonly files: readonly CanonicalCardFileMetadata[];
}
export type CanonicalCardFileContentRead =
  | CardTargetRead<{ readonly card: CardRecord; readonly slot: CanonicalCardFileSlot; readonly snapshot: CanonicalGrowingFileSnapshot<unknown> }>
  | { readonly kind: 'slot-not-found' }
  | { readonly kind: 'too-large'; readonly size: number };

function canonicalProjection(index: CardArtifactIndex): CanonicalCardProjection {
  return { card: index.current.card, snapshot: index.snapshot };
}

function readCanonicalChildrenOfReached(
  realProjectRoot: string,
  parentId: string,
  parent: CardArtifactIndex,
  instrumentation?: CanonicalReadInstrumentation,
): CardArtifactIndex[] {
  const activeChildren: CardArtifactIndex[] = [];
  const parentNamespace = cardNamespace(realProjectRoot, parentId);
  for (const id of parent.current.card.children) {
    const segment = cardIdSegments(id).at(-1)!;
    if (childCardId(parentId, segment) !== id) throw new Error(`Card '${parentId}' has invalid direct child '${id}'.`);
    const childrenPath = join(parentNamespace, 'children');
    proveCanonicalDirectory(realProjectRoot, childrenPath);
    proveCanonicalDirectory(realProjectRoot, join(childrenPath, segment));
    const child = exactStream(realProjectRoot, id, instrumentation);
    if (!child.tombstone) activeChildren.push(child);
  }
  return activeChildren;
}

export function readCanonicalCard(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardProjection> {
  const target = proveActiveCardPath(projectRoot, cardId, instrumentation);
  return target ? { kind: 'found', value: canonicalProjection(target) } : { kind: 'card-not-found' };
}

export function readCanonicalCardHierarchy(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalLinkedChildrenProjection> {
  cardIdSchema.parse(parentId);
  const realProjectRoot = proveCanonicalBase(projectRoot);
  if (realProjectRoot === null) return { kind: 'card-not-found' };
  const target = proveActiveCardPathFromBase(realProjectRoot, parentId, instrumentation);
  if (!target) return { kind: 'card-not-found' };
  const activeChildren = readCanonicalChildrenOfReached(realProjectRoot, parentId, target, instrumentation).map(canonicalProjection);
  return { kind: 'found', value: { parent: canonicalProjection(target), activeChildren } };
}

function fixedSlotMetadata(path: string, descriptor: number): { readonly size: number; readonly modifiedAt: string } {
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`Canonical card artifact '${path}' must be a regular file.`);
    return { size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } finally {
    closeSync(descriptor);
  }
}

export function readCanonicalCardFilesMetadata(projectRoot: string, cardId: string,definitions:readonly RecordDefinition[]): CardTargetRead<CanonicalCardFilesMetadataProjection> {
  const reached = proveActiveCardPathWithRoot(projectRoot, cardId);
  if (!reached) return { kind: 'card-not-found' };
  const files: CanonicalCardFileMetadata[] = [];
  for (const slot of ['card',...definitions.map((definition)=>definition.filename)] as const) {
    const definition = slot === 'card' ? null : definitions.find((value)=>value.filename===slot)!;
    const path = definition === null ? cardStreamFile(reached.realProjectRoot, cardId) : cardRecordStreamFile(reached.realProjectRoot, cardId, definition);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (definition && !definition.bootstrap && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    files.push({ slot, ...fixedSlotMetadata(path, descriptor) });
  }
  return { kind: 'found', value: { card: canonicalProjection(reached.target), files } };
}

function readRecordSlotSnapshot(
  path: string,
  descriptor: number,
  cardId: string,
  definition: RecordDefinition,
  maximumBytes: number,
): { readonly kind: 'found'; readonly snapshot: CanonicalGrowingFileSnapshot<unknown> } | { readonly kind: 'too-large'; readonly size: number } {
  try {
    const initial = fstatSync(descriptor);
    if (!initial.isFile()) throw new Error(`Canonical card artifact '${path}' must be a regular file.`);
    if (initial.size > maximumBytes) return { kind: 'too-large', size: initial.size };
    let bytes = readFileSync(descriptor);
    if (bytes.byteLength > maximumBytes) return { kind: 'too-large', size: bytes.byteLength };
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
      const finalNewline = bytes.lastIndexOf(0x0a);
      const canonicalLength = finalNewline < 0 ? 0 : finalNewline + 1;
      ftruncateSync(descriptor, canonicalLength);
      fsyncSync(descriptor);
      bytes = bytes.subarray(0, canonicalLength);
    }
    const rows = validateRecordStream(parseGrowingFile(path, bytes.toString('utf8'), recordVersionArtifactSchema), path, cardId, definition);
    const final = fstatSync(descriptor);
    return { kind: 'found', snapshot: Object.freeze({ bytes, rows: Object.freeze(rows), size: final.size, modifiedAt: final.mtime.toISOString() }) };
  } finally {
    closeSync(descriptor);
  }
}

export function readCanonicalCardFileContent(
  projectRoot: string,
  cardId: string,
  slot: CanonicalCardFileSlot,
  maximumBytes: number,
  definitions:readonly RecordDefinition[],
): CanonicalCardFileContentRead {
  const reached = proveActiveCardPathWithRoot(projectRoot, cardId);
  if (!reached) return { kind: 'card-not-found' };
  if (slot === 'card') {
    if (reached.target.snapshot.size > maximumBytes) return { kind: 'too-large', size: reached.target.snapshot.size };
    return { kind: 'found', value: { card: reached.target.current.card, slot, snapshot: reached.target.snapshot } };
  }
  const definition = definitions.find((value)=>value.filename===slot);
  if(!definition)return {kind:'slot-not-found'};
  const path = cardRecordStreamFile(reached.realProjectRoot, cardId, definition);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (!definition.bootstrap && (error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'slot-not-found' };
    throw error;
  }
  const result = readRecordSlotSnapshot(path, descriptor, cardId, definition, maximumBytes);
  if (result.kind === 'too-large') return result;
  return { kind: 'found', value: { card: reached.target.current.card, slot, snapshot: result.snapshot } };
}

export function readCardHierarchy(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<LinkedChildrenProjection> {
  const result = readCanonicalCardHierarchy(projectRoot, parentId, instrumentation);
  return result.kind === 'card-not-found'
    ? result
    : { kind: 'found', value: { parent: result.value.parent.card, activeChildren: result.value.activeChildren.map(({ card }) => card) } };
}
export function readLinkedChildrenProjection(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): LinkedChildrenProjection {
  const result = readCardHierarchy(projectRoot, parentId, instrumentation);
  if (result.kind === 'card-not-found') throw new Error(`Parent card '${parentId}' does not exist.`);
  return result.value;
}
export function readLinkedChildren(projectRoot: string, parentId: string, instrumentation?: CanonicalReadInstrumentation): CardRecord[] {
  return readLinkedChildrenProjection(projectRoot, parentId, instrumentation).activeChildren;
}
export function readCardArtifacts(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardArtifactIndex {
  const artifacts = proveActiveCardPath(projectRoot, cardId, instrumentation);
  if (!artifacts) throw new Error(`Card '${cardId}' does not exist.`);
  return artifacts;
}

export function listCards(projectRoot: string): CardRecord[] {
  const realProjectRoot = proveCanonicalBase(projectRoot);
  if (realProjectRoot === null) return [];
  const root = exactStream(realProjectRoot, 'project');
  if (root.tombstone) throw new Error('The project card cannot be tombstoned.');
  const cards: CardRecord[] = [];
  const visit = (artifacts: CardArtifactIndex): void => {
    const card = artifacts.current.card;
    cards.push(card);
    for (const child of readCanonicalChildrenOfReached(realProjectRoot, card.id, artifacts)) visit(child);
  };
  visit(root);
  validateParsedCards({ cards, maxDepth: 5 });
  return cards;
}

function historyFrom(index: CardArtifactIndex): CardHistoryEntry[] {
  return index.artifacts.flatMap((row) => row.history ? [row.history] : []).reverse();
}
export function readCardHistoryList(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardHistoryEntry[]> {
  const target = proveActiveCardPath(projectRoot, cardId, instrumentation);
  return target ? { kind: 'found', value: historyFrom(target) } : { kind: 'card-not-found' };
}
export function readCardHistoryEntry(projectRoot: string, cardId: string, versionSeq: number, instrumentation?: CanonicalReadInstrumentation): CardHistoryEntryRead {
  const target = proveActiveCardPath(projectRoot, cardId, instrumentation);
  if (!target) return { kind: 'card-not-found' };
  const entry = historyFrom(target).find((candidate) => candidate.version_seq === versionSeq);
  return entry ? { kind: 'found', value: entry } : { kind: 'history-entry-not-found', versionSeq };
}
export function readCardDiffIndex(projectRoot: string, cardId: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardArtifactIndex> {
  const target = proveActiveCardPath(projectRoot, cardId, instrumentation);
  return target ? { kind: 'found', value: target } : { kind: 'card-not-found' };
}

function initialBootstrap(cardId: string, content: string, definition:RecordDefinition, stamp: string) {
  return { kind: 'record-revision' as const, format_version: 2 as const, card_id: cardId, record_name:definition.filename, version: 1, revision_seq: 1, state: 'closed' as const, opened_at: stamp, committed_at: stamp, closed_at: stamp, discarded_at: null, reason: null, writer_agent:'runtime:bootstrap' as const, format: definition.format, schema: definition.schema, card_version_seq: 1, content };
}

function publishInitialStreams(projectRoot: string, card: CardRecord, bootstrapContent: string, definition:RecordDefinition, temporary?: PublicationTemporaryIdFactory): void {
  const stamp = new Date().toISOString();
  const bootstrap = initialBootstrap(card.id, bootstrapContent,definition, stamp);
  validateRecordStream([recordVersionArtifactSchema.parse(bootstrap)],cardRecordStreamFile(projectRoot,card.id,definition),card.id,definition);
  const cardPath = cardStreamFile(projectRoot, card.id);
  const prepared = prepareGrowingEnvelope([{ kind: 'card-version', format_version: 2, card_id: card.id, version: 1, committed_at: stamp, card, history: null }], cardStreamRowSchema);
  validateCardStream(prepared.rows, cardPath, card.id);
  const bootstrapBytes=serializeGrowingEnvelope([bootstrap], recordVersionArtifactSchema);
  publishFirstEnvelope(cardRecordStreamFile(projectRoot, card.id, definition), bootstrapBytes, temporary);
  publishFirstEnvelope(cardPath, prepared.bytes, temporary);
}

function claimChildNamespace(projectRoot: string, parentId: string): string {
  const parentNamespace = cardNamespace(projectRoot, parentId);
  const childrenPath = join(parentNamespace, 'children');
  try { mkdirSync(childrenPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; requireDirectory(childrenPath); }
  let segment = nextCardSegment();
  for (;;) {
    const id = childCardId(parentId, segment);
    try {
      mkdirSync(cardNamespace(projectRoot, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      segment = nextCardSegment(segment);
    }
  }
}

export function publishInitialChildCard(projectRoot: string, input: NewChildCardInput, workflow:CompiledCardTypeWorkflow, temporary?: PublicationTemporaryIdFactory): CardRecord {
  if(workflow.cardType!==input.type)throw new Error(`Compiled workflow '${workflow.cardType}' does not match child type '${input.type}'.`);
  const bootstrapDefinition:RecordDefinition={filename:workflow.bootstrapRecord.name,writers:workflow.bootstrapRecord.writers,format:workflow.bootstrapRecord.format,schema:workflow.bootstrapRecord.schema,bootstrap:true};
  const id = claimChildNamespace(projectRoot, input.parent);
  if (cardParentId(id) !== input.parent) throw new Error(`Claimed card '${id}' does not belong to requested parent '${input.parent}'.`);
  const stamp = new Date().toISOString();
  const card = cardRecordSchema.parse({
    id, type: input.type, children: [], title: input.title, subtype: null, tags: input.tags,
    priority: input.priority, urgency: input.urgency, created_by: input.created_by,
    created_at: stamp, updated_at: stamp, version_seq: 1, assigned_to: null,
    depends_on: input.depends_on, related: input.related,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null,
    latest_self_report: null, metadata: null, pending_notifications: [],
  });
  mkdirSync(join(cardNamespace(projectRoot, id), 'conversations'));
  publishInitialStreams(projectRoot, card, input.bootstrap_content, bootstrapDefinition, temporary);
  return card;
}

export function publishInitialProjectCard(projectRoot: string, input: NewProjectRootInput, workflow:CompiledCardTypeWorkflow, temporary?: PublicationTemporaryIdFactory): void {
  if(workflow.cardType!=='project')throw new Error(`Initial project publication requires the compiled project workflow.`);
  const bootstrapDefinition:RecordDefinition={filename:workflow.bootstrapRecord.name,writers:workflow.bootstrapRecord.writers,format:workflow.bootstrapRecord.format,schema:workflow.bootstrapRecord.schema,bootstrap:true};
  if(input.bootstrap_content.trim().length===0)throw new Error('Project bootstrap_content must contain non-whitespace Markdown.');
  const stamp = new Date().toISOString();
  const card = cardRecordSchema.parse({
    id: 'project', type: 'project', children: [], title: input.title, subtype: null,
    tags: [], priority: 0, urgency: 'normal', created_by: 'runtime:bootstrap', created_at: stamp,
    updated_at: stamp, version_seq: 1, assigned_to: null, depends_on: [], related: [],
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null,
    status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null,
    metadata: null, pending_notifications: [],
  });
  mkdirSync(cardNamespace(projectRoot, 'project'));
  mkdirSync(join(cardNamespace(projectRoot, 'project'), 'conversations'));
  mkdirSync(join(projectRoot, '.saivage', 'agents'));
  mkdirSync(join(projectRoot, '.saivage', 'agents', 'conversations'));
  publishInitialStreams(projectRoot, card, input.bootstrap_content, bootstrapDefinition, temporary);
}

export function publishCardVersion(projectRoot: string, card: CardRecord, history: CardHistoryEntry | null, io?: GrowingFileIo): CardVersionArtifact {
  const path = cardStreamFile(projectRoot, card.id);
  const prepared = prepareGrowingEnvelope([{ kind: 'card-version', format_version: 2, card_id: card.id, version: card.version_seq, committed_at: new Date().toISOString(), card, history }], cardStreamRowSchema);
  const row = prepared.rows[0]!;
  if (row.kind !== 'card-version') throw new Error('Prepared card-version row has the wrong kind.');
  const stream = readCardArtifacts(projectRoot, row.card_id);
  const current = stream.current.card;
  if (row.version !== current.version_seq + 1) throw new Error(`Card '${row.card_id}' expected version ${current.version_seq + 1}.`);
  validateCardStream([...stream.artifacts, row], path, row.card_id);
  const result = appendEnvelope(path, prepared.bytes, io);
  switch (result.kind) {
    case 'appended': break;
    case 'missing': throw new Error(`Card stream for '${row.card_id}' disappeared before version append.`);
  }
  return row;
}

export function publishCardTombstone(projectRoot: string, cardId: string, finalCard: CardRecord, deletionHistory: CardHistoryEntry, io?: GrowingFileIo): CardTombstone {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.');
  const path = cardStreamFile(projectRoot, cardId);
  const prepared = prepareGrowingEnvelope([{ kind: 'card-tombstone', format_version: 2, card_id: cardId, deleted_at: deletionHistory.changed_at, final_card: finalCard, deletion_history: deletionHistory }], cardStreamRowSchema);
  const row = prepared.rows[0]!;
  if (row.kind !== 'card-tombstone') throw new Error('Prepared card-tombstone row has the wrong kind.');
  const stream = readCardArtifacts(projectRoot, cardId);
  validateCardStream([...stream.artifacts, row], path, cardId);
  const result = appendEnvelope(path, prepared.bytes, io);
  switch (result.kind) {
    case 'appended': break;
    case 'missing': throw new Error(`Card stream for '${cardId}' disappeared before tombstone append.`);
  }
  return row;
}
