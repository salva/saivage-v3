import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateParsedCards } from '../cards/artifact-api.js';
import type { NewChildCardInput } from '../cards/store-api.js';
import {
  cardIdSchema,
  cardIdSegments,
  cardParentId,
  childCardId,
  nextCardSegment,
} from '../schemas/index.js';
import {
  cardAgentSessionId,
  cardRecordSchema,
  type AgentName,
  type CardRecord,
  type RecordName,
} from '../schemas/index.js';
import type { RecordDefinition } from '../records/index.js';
import type { CompiledCardTypeWorkflow } from '../runtime/runtime-api.js';
import { initializeAuthoredRecord } from './authored-record-files.js';
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
import {
  appendRequiredEnvelope,
  publishFirstEnvelope,
  readCanonicalBytes,
  readCanonicalBytesOrMissing,
  consumeGrowingRows,
  serializeGrowingEnvelope,
  type CanonicalReadInstrumentation,
  type GrowingFileIo,
} from './growing-file.js';
import {
  cardChildrenRoot,
  cardConversationsRoot,
  cardNamespace,
  cardStreamFile,
  globalAgentConversationsRoot,
  saivageAgentsRoot,
} from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface CanonicalLinkedCardHistoryProjection {
  readonly current: CardRecord;
  readonly tombstone: CardTombstoneArtifact | null;
  readonly rows: readonly CardArtifact[];
}

export type CardTargetRead<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'card-not-found' };
export interface InitialProjectCardInput {
  readonly title: string;
  readonly bootstrap_content: string;
}
interface ActiveCardPathRead {
  readonly canonicalProjectRoot: string;
  readonly fold: CardStreamFold;
}
interface CommittedCardArtifactCatalog {
  readonly rows: readonly CardArtifact[];
  readonly versions: readonly CardVersionListEntry[];
  readonly head: CardArtifact;
}
interface ActiveCardTraversalRow {
  readonly card: CardRecord;
  readonly parentId: string | null;
  readonly activeChildrenCount: number;
  readonly relativeDepth: number;
  readonly activeDescendantCount: number;
}

function readExactCard(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold {
  const path = cardStreamFile(projectRoot, cardId);
  return consumeGrowingRows(
    path,
    readCanonicalBytes(path, instrumentation),
    cardArtifactSchema,
    (rows) => validateCardStream(rows, path, cardId),
  );
}

function readRoot(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold | null {
  const path = cardStreamFile(projectRoot, 'project');
  const bytes = readCanonicalBytesOrMissing(path, instrumentation);
  if (bytes === null) return null;
  return consumeGrowingRows(path, bytes, cardArtifactSchema, (rows) =>
    validateCardStream(rows, path, 'project'),
  );
}

function readLinkedCard(
  projectRoot: string,
  targetId: string,
  terminalTombstone: boolean,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold | null {
  const segments = cardIdSegments(targetId);
  let currentId = 'project';
  let current = readRoot(projectRoot, instrumentation);
  if (!current) return null;
  for (const [position, segment] of segments.entries()) {
    const nextId = childCardId(currentId, segment);
    if (!current.current.card.child_membership.includes(nextId)) return null;
    current = readExactCard(projectRoot, nextId, instrumentation);
    if (current.tombstone && !(terminalTombstone && position === segments.length - 1)) return null;
    currentId = nextId;
  }
  return current;
}

export function readActiveCardPath(
  projectRoot: string,
  targetId: string,
  instrumentation?: CanonicalReadInstrumentation,
): ActiveCardPathRead | null {
  cardIdSchema.parse(targetId);
  const realProjectRoot = resolve(projectRoot);
  const target = readLinkedCard(realProjectRoot, targetId, false, instrumentation);
  return target ? { canonicalProjectRoot: realProjectRoot, fold: target } : null;
}

function readActiveCardFold(
  projectRoot: string,
  targetId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold | null {
  return readActiveCardPath(projectRoot, targetId, instrumentation)?.fold ?? null;
}
export function readCard(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardRecord | null {
  return readActiveCardFold(projectRoot, cardId, instrumentation)?.current.card ?? null;
}
export function readCardDetail(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CardRecord> {
  const target = readActiveCardFold(projectRoot, cardId, instrumentation);
  return target ? { kind: 'found', value: target.current.card } : { kind: 'card-not-found' };
}

interface LinkedChildrenProjection {
  readonly parent: CardRecord;
  readonly activeChildren: CardRecord[];
}
export interface CanonicalCardProjection {
  readonly card: CardRecord;
  readonly artifact: CardArtifact;
}
export interface CanonicalLinkedChildrenProjection {
  readonly parent: CanonicalCardProjection;
  readonly activeChildren: CanonicalCardProjection[];
}
export type CanonicalCardFileSlot = 'card' | RecordName;

function canonicalProjection(fold: CardStreamFold): CanonicalCardProjection {
  return { card: fold.current.card, artifact: fold.head };
}
function readMembershipChildrenOfReached(
  realProjectRoot: string,
  parentId: string,
  parent: CardStreamFold,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold[] {
  if (parent.current.card.child_membership.length === 0) return [];
  return parent.current.card.child_membership.map((id) => {
    const segment = cardIdSegments(id).at(-1)!;
    if (childCardId(parentId, segment) !== id)
      throw new Error(`Card '${parentId}' has invalid direct child '${id}'.`);
    return readExactCard(realProjectRoot, id, instrumentation);
  });
}

function readCanonicalChildrenOfReached(
  realProjectRoot: string,
  parentId: string,
  parent: CardStreamFold,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold[] {
  const byId = new Map<string, CardStreamFold>();
  for (const child of readMembershipChildrenOfReached(
    realProjectRoot,
    parentId,
    parent,
    instrumentation,
  ))
    byId.set(child.current.card.id, child);
  return parent.current.card.active_child_order.flatMap((id) => {
    const child = byId.get(id);
    if (!child)
      throw new Error(`Card '${parentId}' has unresolved active child order member '${id}'.`);
    return child.tombstone ? [] : [child];
  });
}

export function readCanonicalCard(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CanonicalCardProjection> {
  const target = readActiveCardFold(projectRoot, cardId, instrumentation);
  return target
    ? { kind: 'found', value: canonicalProjection(target) }
    : { kind: 'card-not-found' };
}
export function readCanonicalCardHierarchy(
  projectRoot: string,
  parentId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CanonicalLinkedChildrenProjection> {
  cardIdSchema.parse(parentId);
  const realProjectRoot = resolve(projectRoot);
  const target = readLinkedCard(realProjectRoot, parentId, false, instrumentation);
  if (!target) return { kind: 'card-not-found' };
  return {
    kind: 'found',
    value: {
      parent: canonicalProjection(target),
      activeChildren: readCanonicalChildrenOfReached(
        realProjectRoot,
        parentId,
        target,
        instrumentation,
      ).map(canonicalProjection),
    },
  };
}

export function readCardHierarchy(
  projectRoot: string,
  parentId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<LinkedChildrenProjection> {
  const result = readCanonicalCardHierarchy(projectRoot, parentId, instrumentation);
  return result.kind === 'card-not-found'
    ? result
    : {
        kind: 'found',
        value: {
          parent: result.value.parent.card,
          activeChildren: result.value.activeChildren.map(({ card }) => card),
        },
      };
}
export function readLinkedChildrenProjection(
  projectRoot: string,
  parentId: string,
  instrumentation?: CanonicalReadInstrumentation,
): LinkedChildrenProjection {
  const result = readCardHierarchy(projectRoot, parentId, instrumentation);
  if (result.kind === 'card-not-found')
    throw new Error(`Parent card '${parentId}' does not exist.`);
  return result.value;
}
export function readLinkedChildren(
  projectRoot: string,
  parentId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardRecord[] {
  return readLinkedChildrenProjection(projectRoot, parentId, instrumentation).activeChildren;
}
function readCardArtifacts(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardStreamFold {
  const fold = readActiveCardFold(projectRoot, cardId, instrumentation);
  if (!fold) throw new Error(`Card '${cardId}' does not exist.`);
  return fold;
}

function walkActivePreorder(
  realProjectRoot: string,
  root: CardStreamFold,
  instrumentation?: CanonicalReadInstrumentation,
): ActiveCardTraversalRow[] {
  const rows: ActiveCardTraversalRow[] = [];
  const visit = (fold: CardStreamFold, depth: number): number => {
    const children = readCanonicalChildrenOfReached(
      realProjectRoot,
      fold.current.card.id,
      fold,
      instrumentation,
    );
    const row: ActiveCardTraversalRow = {
      card: fold.current.card,
      parentId: cardParentId(fold.current.card.id),
      activeChildrenCount: children.length,
      relativeDepth: depth,
      activeDescendantCount: 0,
    };
    rows.push(row);
    let descendants = 0;
    for (const child of children) descendants += 1 + visit(child, depth + 1);
    (row as { activeDescendantCount: number }).activeDescendantCount = descendants;
    return descendants;
  };
  visit(root, 0);
  return rows;
}

export function listActiveCardTraversal(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): readonly ActiveCardTraversalRow[] {
  const realProjectRoot = resolve(projectRoot);
  const root = readRoot(realProjectRoot, instrumentation);
  if (!root) return [];
  const rows = walkActivePreorder(realProjectRoot, root, instrumentation);
  validateParsedCards({ cards: rows.map(({ card }) => card) });
  return rows;
}
export function readActiveCardSubtree(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<readonly ActiveCardTraversalRow[]> {
  const reached = readActiveCardPath(projectRoot, cardId, instrumentation);
  if (!reached) return { kind: 'card-not-found' };
  return {
    kind: 'found',
    value: walkActivePreorder(reached.canonicalProjectRoot, reached.fold, instrumentation),
  };
}

export function listCards(projectRoot: string): CardRecord[] {
  return listActiveCardTraversal(projectRoot).map(({ card }) => card);
}

export function readCanonicalLinkedCardHistoryTree(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): readonly CanonicalLinkedCardHistoryProjection[] {
  const realProjectRoot = resolve(projectRoot);
  const root = readRoot(realProjectRoot, instrumentation);
  if (!root) return [];
  const reached: CanonicalLinkedCardHistoryProjection[] = [];
  const visit = (cardId: string, current: CardStreamFold): void => {
    reached.push(
      Object.freeze({
        current: current.current.card,
        tombstone: current.tombstone,
        rows: current.rows,
      }),
    );
    if (current.tombstone) return;
    for (const child of readMembershipChildrenOfReached(
      realProjectRoot,
      cardId,
      current,
      instrumentation,
    ))
      visit(child.current.card.id, child);
  };
  visit('project', root);
  return Object.freeze(reached);
}

export function readCommittedCardArtifactCatalog(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CommittedCardArtifactCatalog> {
  cardIdSchema.parse(cardId);
  const fold = readLinkedCard(resolve(projectRoot), cardId, true, instrumentation);
  return fold
    ? {
        kind: 'found',
        value: Object.freeze({
          rows: fold.rows,
          versions: fold.rows.map(cardVersionListEntry),
          head: fold.head,
        }),
      }
    : { kind: 'card-not-found' };
}

type CardDiffValue = { readonly deleted: boolean; readonly card: CardRecord };
export function cardDiffValue(artifact: CardArtifact): CardDiffValue {
  return artifact.kind === 'card-version'
    ? { deleted: false, card: artifact.card }
    : { deleted: true, card: artifact.final_card };
}

function appendCardRow(path: string, artifact: CardArtifact, io?: GrowingFileIo): void {
  appendRequiredEnvelope(path, serializeGrowingEnvelope([artifact]), io);
}

function publishInitialStreams(
  projectRoot: string,
  card: CardRecord,
  bootstrapContent: string,
  definitions: readonly RecordDefinition[],
  temporary?: PublicationTemporaryIdFactory,
): void {
  for (const definition of definitions)
    initializeAuthoredRecord(
      projectRoot,
      card.id,
      definition,
      definition.bootstrap ? bootstrapContent : undefined,
      temporary,
    );
  publishCardVersion(projectRoot, card, null, undefined, temporary);
}

function initializeCardConversations(
  projectRoot: string,
  card: CardRecord,
  workflow: CompiledCardTypeWorkflow,
  temporary?: PublicationTemporaryIdFactory,
): void {
  const names = new Set<AgentName>();
  for (const state of workflow.states.values())
    if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
  for (const name of names)
    initializeConversation(projectRoot, cardAgentSessionId(name, card.id), temporary);
}

function claimChildNamespace(projectRoot: string, parentId: string): string {
  const childrenPath = cardChildrenRoot(projectRoot, parentId);
  try {
    mkdirSync(childrenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
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

export function publishInitialChildCard(
  projectRoot: string,
  input: NewChildCardInput,
  workflow: CompiledCardTypeWorkflow,
  temporary?: PublicationTemporaryIdFactory,
): CardRecord {
  if (workflow.cardType !== input.type)
    throw new Error(
      `Compiled workflow '${workflow.cardType}' does not match child type '${input.type}'.`,
    );
  const id = claimChildNamespace(projectRoot, input.parent);
  if (cardParentId(id) !== input.parent)
    throw new Error(`Claimed card '${id}' does not belong to requested parent '${input.parent}'.`);
  const stamp = new Date().toISOString();
  const card = cardRecordSchema.parse({
    id,
    type: input.type,
    child_membership: [],
    active_child_order: [],
    title: input.title,
    subtype: null,
    priority: input.priority,
    urgency: input.urgency,
    created_by: input.created_by,
    created_at: stamp,
    updated_at: stamp,
    version_seq: 1,
    assigned_to: null,
    depends_on: input.depends_on,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    metadata: null,
    pending_notifications: [],
  });
  const definitions = [...workflow.records.values()].map(
    (record): RecordDefinition => ({
      filename: record.name,
      format: record.format,
      schema: record.schema,
      bootstrap: record.bootstrap,
      declared: true,
    }),
  );
  mkdirSync(cardConversationsRoot(projectRoot, id));
  initializeCardConversations(projectRoot, card, workflow, temporary);
  publishInitialStreams(projectRoot, card, input.bootstrap_content, definitions, temporary);
  return card;
}

export function publishInitialProjectCard(
  projectRoot: string,
  input: InitialProjectCardInput,
  workflow: CompiledCardTypeWorkflow,
  temporary?: PublicationTemporaryIdFactory,
): void {
  if (workflow.cardType !== 'project')
    throw new Error('Initial project publication requires the compiled project workflow.');
  if (input.bootstrap_content.trim().length === 0)
    throw new Error('Project bootstrap_content must contain non-whitespace Markdown.');
  const stamp = new Date().toISOString();
  const card = cardRecordSchema.parse({
    id: 'project',
    type: 'project',
    child_membership: [],
    active_child_order: [],
    title: input.title,
    subtype: null,
    priority: 0,
    urgency: 'normal',
    created_by: 'runtime:bootstrap',
    created_at: stamp,
    updated_at: stamp,
    version_seq: 1,
    assigned_to: null,
    depends_on: [],
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    metadata: null,
    pending_notifications: [],
  });
  const definitions = [...workflow.records.values()].map(
    (record): RecordDefinition => ({
      filename: record.name,
      format: record.format,
      schema: record.schema,
      bootstrap: record.bootstrap,
      declared: true,
    }),
  );
  mkdirSync(cardNamespace(projectRoot, 'project'));
  mkdirSync(cardConversationsRoot(projectRoot, 'project'));
  mkdirSync(saivageAgentsRoot(projectRoot));
  mkdirSync(globalAgentConversationsRoot(projectRoot));
  initializeCardConversations(projectRoot, card, workflow, temporary);
  publishInitialStreams(projectRoot, card, input.bootstrap_content, definitions, temporary);
}

export function publishCardVersion(
  projectRoot: string,
  card: CardRecord,
  change: CardVersionChange | null,
  io?: GrowingFileIo,
  temporary?: PublicationTemporaryIdFactory,
): CardVersionArtifact {
  const path = cardStreamFile(projectRoot, card.id);
  if (change === null) {
    const artifact = cardVersionArtifactSchema.parse({
      format_version: 4,
      kind: 'card-version',
      entry_id: randomUUID(),
      card_id: card.id,
      version: 1,
      committed_at: card.created_at,
      card,
      change: null,
    });
    validateInitialCard(artifact.card, path);
    publishFirstEnvelope(path, serializeGrowingEnvelope([artifact]), temporary);
    return artifact;
  }
  const fold = readExactCard(projectRoot, card.id);
  if (fold.tombstone) throw new Error(`Card '${card.id}' is terminal.`);
  const artifact = cardVersionArtifactSchema.parse({
    format_version: 4,
    kind: 'card-version',
    entry_id: change.entry_id,
    card_id: card.id,
    version: fold.head.version + 1,
    committed_at: change.changed_at,
    card,
    change,
  });
  validateCardTransition(fold.current.card, artifact.card, artifact.change!, path);
  appendCardRow(path, artifact, io);
  return artifact;
}

export function publishCardTombstone(
  projectRoot: string,
  cardId: string,
  finalCard: CardRecord,
  change: CardVersionChange,
  io?: GrowingFileIo,
): CardTombstoneArtifact {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.');
  const fold = readCardArtifacts(projectRoot, cardId);
  if (fold.tombstone) throw new Error(`Card '${cardId}' is terminal.`);
  if (JSON.stringify(fold.current.card) !== JSON.stringify(finalCard))
    throw new Error(`Card '${cardId}' tombstone final card must equal current.`);
  const artifact = cardTombstoneArtifactSchema.parse({
    format_version: 4,
    kind: 'card-tombstone',
    entry_id: change.entry_id,
    card_id: cardId,
    version: fold.head.version + 1,
    committed_at: change.changed_at,
    prior_card_version: finalCard.version_seq,
    final_card: finalCard,
    change,
  });
  appendCardRow(cardStreamFile(projectRoot, cardId), artifact, io);
  return artifact;
}
