import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateParsedCards } from '../cards/status-api.js';
import { summarizeChangedFields } from '../cards/status-api.js';
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
  cardNotificationSchema,
  valuesEqual,
  type CardNotification,
  type AgentName,
  type CardRecord,
  type RecordName,
  type RecordDefinition,
} from '../schemas/index.js';
import type { CompiledCardTypeWorkflow } from '../runtime/runtime-api.js';
import { initializeAuthoredRecord } from './authored-record-files.js';
import { initializeConversation } from './conversation-file.js';
import {
  cardArtifactSchema,
  cardTombstoneArtifactSchema,
  cardVersionArtifactSchema,
  cardVersionListEntry,
  cardVersionChangeSchema,
  cardHeadSchema,
  cardMailboxMessageSchema,
  ordinaryCardPayload,
  validateInitialCard,
  validateCardTransition,
  type CardArtifact,
  type CurrentCardSelection,
  type CardArtifactReference,
  type CardTombstoneArtifact,
  type CardVersionArtifact,
  type CardVersionChange,
  type CardVersionListEntry,
} from './canonical-card-artifacts.js';
import {
  readCanonicalBytes,
  readCanonicalBytesOrMissing,
  type CanonicalReadInstrumentation,
} from './growing-file.js';
import {
  cardChildrenRoot,
  cardConversationsRoot,
  cardNamespace,
  cardHeadFile,
  cardPreviousHeadFile,
  cardHistoryFile,
  cardHistoryRoot,
  cardMailboxFile,
  cardMailboxRoot,
  cardRecordsRoot,
  cardAcceptedRecordsRoot,
  globalAgentConversationsRoot,
  saivageAgentsRoot,
} from './layout.js';
import { publishHeadFile } from './publish-head.js';
import {
  publishFreshFile,
  type PublicationTemporaryIdFactory,
  type ReplacementFileIo,
} from './replace-file.js';

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
  readonly fold: CurrentCardSelection;
}
interface CommittedCardArtifactCatalog {
  readonly rows: readonly CardArtifact[];
  readonly versions: readonly CardVersionListEntry[];
  readonly head: CardArtifact;
  readonly current: CanonicalCardProjection;
}
interface ActiveCardTraversalRow {
  readonly card: CardRecord;
  readonly headId: string;
  readonly parentId: string | null;
  readonly activeChildrenCount: number;
  readonly relativeDepth: number;
  readonly activeDescendantCount: number;
}

function readExactCard(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection {
  const path = cardHeadFile(projectRoot, cardId);
  return decodeCurrent(
    projectRoot,
    cardId,
    readCanonicalBytes(path, instrumentation),
    instrumentation,
  );
}

function readArtifact(
  projectRoot: string,
  cardId: string,
  reference: CardArtifactReference,
  instrumentation?: CanonicalReadInstrumentation,
): CardArtifact {
  const artifact = cardArtifactSchema.parse(
    parseJson(
      readCanonicalBytes(cardHistoryFile(projectRoot, cardId, reference.entry_id), instrumentation),
    ),
  );
  if (
    artifact.card_id !== cardId ||
    artifact.entry_id !== reference.entry_id ||
    artifact.version !== reference.version
  )
    throw new Error(`Card '${cardId}' history reference and document identity disagree.`);
  return artifact;
}
function decodeCurrent(
  projectRoot: string,
  cardId: string,
  bytes: Buffer,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection {
  const selection = cardHeadSchema.parse(parseJson(bytes));
  if (selection.card_id !== cardId) throw new Error(`Card '${cardId}' head owner mismatch.`);
  const head = readArtifact(projectRoot, cardId, selection.ordinary, instrumentation);
  const tombstone = head.kind === 'card-tombstone' ? head : null;
  if (
    tombstone &&
    (selection.version_seq !== tombstone.version ||
      selection.updated_at !== tombstone.committed_at ||
      selection.pending.length !== 0)
  )
    throw new Error(`Card '${cardId}' invalid tombstone selection.`);
  if (selection.version_seq === head.version && selection.updated_at !== head.committed_at)
    throw new Error(`Card '${cardId}' current time and selected history disagree.`);
  const card =
    head.kind === 'card-tombstone'
      ? head.final_card
      : cardRecordSchema.parse({
          ...head.card,
          version_seq: selection.version_seq,
          updated_at: selection.updated_at,
          pending_notifications: selection.pending,
        });
  return { selection, head, current: { card, committed_at: selection.updated_at }, tombstone };
}

function readHistory(
  projectRoot: string,
  current: CurrentCardSelection,
  instrumentation?: CanonicalReadInstrumentation,
  stopAt?: number,
): CardArtifact[] {
  const rows: CardArtifact[] = [];
  let artifact = current.head;
  for (;;) {
    rows.push(artifact);
    if (stopAt !== undefined && artifact.version <= stopAt) break;
    const previous = artifact.predecessor;
    if (previous === null) break;
    const prior = readArtifact(projectRoot, artifact.card_id, previous, instrumentation);
    if (prior.kind !== 'card-version' || prior.version >= artifact.version)
      throw new Error(`Card '${artifact.card_id}' invalid predecessor linkage.`);
    if (artifact.kind === 'card-version')
      validateCardTransition(
        prior.card,
        artifact.card,
        artifact.change!,
        artifact.card_id,
        'history',
      );
    else if (
      !valuesEqual(ordinaryCardPayload(prior.card), ordinaryCardPayload(artifact.final_card))
    )
      throw new Error(
        `Card '${artifact.card_id}' tombstone ordinary payload differs from predecessor.`,
      );
    artifact = prior;
  }
  return rows.reverse();
}

export function readPendingCardNotifications(
  projectRoot: string,
  cardId: string,
): CardNotification[] {
  const current = readActiveCardFold(projectRoot, cardId);
  if (!current) throw new Error(`Card '${cardId}' does not exist.`);
  return current.selection.pending.map((id) => {
    const message = cardMailboxMessageSchema.parse(
      parseJson(readCanonicalBytes(cardMailboxFile(projectRoot, cardId, id))),
    );
    if (message.card_id !== cardId || message.notification.id !== id)
      throw new Error(`Card '${cardId}' mailbox reference and document identity disagree.`);
    return message.notification;
  });
}

function readRoot(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection | null {
  const path = cardHeadFile(projectRoot, 'project');
  const bytes = readCanonicalBytesOrMissing(path, instrumentation);
  if (bytes === null) return null;
  return decodeCurrent(projectRoot, 'project', bytes, instrumentation);
}

function readLinkedCard(
  projectRoot: string,
  targetId: string,
  terminalTombstone: boolean,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection | null {
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
): CurrentCardSelection | null {
  return readActiveCardPath(projectRoot, targetId, instrumentation)?.fold ?? null;
}
export function readCard(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardRecord | null {
  return readActiveCardFold(projectRoot, cardId, instrumentation)?.current.card ?? null;
}
interface LinkedChildrenProjection {
  readonly parent: CardRecord;
  readonly activeChildren: CardRecord[];
}
export interface CanonicalCardProjection {
  readonly card: CardRecord;
  readonly artifact: CardArtifact;
  readonly headId: string;
}
export interface CanonicalLinkedChildrenProjection {
  readonly parent: CanonicalCardProjection;
  readonly activeChildren: CanonicalCardProjection[];
}
export type CanonicalCardFileSlot = 'card' | RecordName;

function canonicalProjection(fold: CurrentCardSelection): CanonicalCardProjection {
  return { card: fold.current.card, artifact: fold.head, headId: fold.selection.head_id };
}
function readMembershipChildrenOfReached(
  realProjectRoot: string,
  parentId: string,
  parent: CurrentCardSelection,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection[] {
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
  parent: CurrentCardSelection,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentCardSelection[] {
  const byId = new Map<string, CurrentCardSelection>();
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
): CurrentCardSelection {
  const fold = readActiveCardFold(projectRoot, cardId, instrumentation);
  if (!fold) throw new Error(`Card '${cardId}' does not exist.`);
  return fold;
}

function walkActivePreorder(
  realProjectRoot: string,
  root: CurrentCardSelection,
  instrumentation?: CanonicalReadInstrumentation,
): ActiveCardTraversalRow[] {
  const rows: ActiveCardTraversalRow[] = [];
  const visit = (fold: CurrentCardSelection, depth: number): number => {
    const children = readCanonicalChildrenOfReached(
      realProjectRoot,
      fold.current.card.id,
      fold,
      instrumentation,
    );
    const row: ActiveCardTraversalRow = {
      card: fold.current.card,
      headId: fold.selection.head_id,
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
  const visit = (cardId: string, current: CurrentCardSelection): void => {
    reached.push(
      Object.freeze({
        current: current.current.card,
        tombstone: current.tombstone,
        rows: readHistory(realProjectRoot, current, instrumentation),
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
  const rows = fold ? readHistory(resolve(projectRoot), fold, instrumentation) : [];
  return fold
    ? {
        kind: 'found',
        value: Object.freeze({
          rows,
          versions: rows.map(cardVersionListEntry),
          head: fold.head,
          current: canonicalProjection(fold),
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

export function readCommittedCardCurrent(
  projectRoot: string,
  cardId: string,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CanonicalCardProjection> {
  cardIdSchema.parse(cardId);
  const fold = readLinkedCard(resolve(projectRoot), cardId, true, instrumentation);
  return fold ? { kind: 'found', value: canonicalProjection(fold) } : { kind: 'card-not-found' };
}
export function readCommittedCardVersionPair(
  projectRoot: string,
  cardId: string,
  pivots: { from: number; to: number },
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<{ from: CardArtifact | null; to: CardArtifact | null }> {
  cardIdSchema.parse(cardId);
  const fold = readLinkedCard(resolve(projectRoot), cardId, true, instrumentation);
  if (!fold) return { kind: 'card-not-found' };
  const rows = readHistory(resolve(projectRoot), fold, instrumentation, pivots.from);
  return {
    kind: 'found',
    value: {
      from: rows.find((row) => row.version === pivots.from) ?? null,
      to: rows.find((row) => row.version === pivots.to) ?? null,
    },
  };
}
export function readCommittedCardVersion(
  projectRoot: string,
  cardId: string,
  version: number,
  instrumentation?: CanonicalReadInstrumentation,
): CardTargetRead<CardArtifact | null> {
  cardIdSchema.parse(cardId);
  const fold = readLinkedCard(resolve(projectRoot), cardId, true, instrumentation);
  return fold
    ? {
        kind: 'found',
        value:
          readHistory(resolve(projectRoot), fold, instrumentation, version).find(
            (row) => row.version === version,
          ) ?? null,
      }
    : { kind: 'card-not-found' };
}

function publishInitialCardState(
  projectRoot: string,
  card: CardRecord,
  bootstrapContent: string,
  definitions: readonly RecordDefinition[],
  temporary?: PublicationTemporaryIdFactory,
): void {
  mkdirSync(cardHistoryRoot(projectRoot, card.id));
  mkdirSync(cardMailboxRoot(projectRoot, card.id));
  mkdirSync(cardRecordsRoot(projectRoot, card.id));
  mkdirSync(cardAcceptedRecordsRoot(projectRoot, card.id));
  const initialEntryId = randomUUID();
  for (const definition of definitions)
    initializeAuthoredRecord(
      projectRoot,
      card.id,
      definition,
      { entry_id: initialEntryId, version: 1 },
      definition.bootstrap ? bootstrapContent : undefined,
      temporary,
    );
  publishCardVersion(projectRoot, card, null, undefined, temporary, undefined, initialEntryId);
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
  publishInitialCardState(projectRoot, card, input.bootstrap_content, definitions, temporary);
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
  publishInitialCardState(projectRoot, card, input.bootstrap_content, definitions, temporary);
}

export function publishCardVersion(
  projectRoot: string,
  card: CardRecord,
  change: CardVersionChange | null,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
  notification?: CardNotification,
  initialEntryId?: string,
): CardVersionArtifact | null {
  const path = cardHeadFile(projectRoot, card.id);
  if (change === null) {
    card = cardRecordSchema.parse(card);
    validateInitialCard(card, path);
    const artifact = cardVersionArtifactSchema.parse({
      format_version: 1,
      kind: 'card-version',
      entry_id: initialEntryId ?? randomUUID(),
      card_id: card.id,
      version: 1,
      committed_at: card.created_at,
      card: ordinaryCardPayload(card),
      predecessor: null,
      change: null,
    });
    publishFreshFile(
      cardHistoryFile(projectRoot, card.id, artifact.entry_id),
      serializeArtifact(artifact),
      temporary,
      io,
    );
    publishHeadFile(
      path,
      cardPreviousHeadFile(projectRoot, card.id),
      jsonBytes(
        cardHeadSchema.parse({
          format_version: 1,
          kind: 'card-head',
          head_id: randomUUID(),
          card_id: card.id,
          version_seq: 1,
          updated_at: card.updated_at,
          ordinary: referenceOf(artifact),
          pending: [],
        }),
      ),
      'initial',
      temporary,
      io,
    );
    return artifact;
  }
  const fold = readExactCard(projectRoot, card.id);
  if (fold.tombstone) throw new Error(`Card '${card.id}' is terminal.`);
  card = cardRecordSchema.parse(card);
  change = cardVersionChangeSchema.parse(change);
  validateCardTransition(fold.current.card, card, change, path);
  if (change.kind === 'notification_enqueue' || change.kind === 'notification_remove') {
    if (change.kind === 'notification_enqueue') {
      const message = cardMailboxMessageSchema.parse({
        format_version: 1,
        kind: 'card-message',
        card_id: card.id,
        notification: cardNotificationSchema.parse(notification),
      });
      if (message.notification.id !== card.pending_notifications.at(-1))
        throw new Error(`Card '${card.id}' enqueued message identity mismatch.`);
      publishFreshFile(
        cardMailboxFile(projectRoot, card.id, message.notification.id),
        jsonBytes(message),
        temporary,
        io,
      );
    }
    publishHeadFile(
      path,
      cardPreviousHeadFile(projectRoot, card.id),
      jsonBytes(
        cardHeadSchema.parse({
          ...fold.selection,
          head_id: randomUUID(),
          version_seq: card.version_seq,
          updated_at: card.updated_at,
          pending: card.pending_notifications,
        }),
      ),
      'replacement',
      temporary,
      io,
    );
    return null;
  }
  const artifact = cardVersionArtifactSchema.parse({
    format_version: 1,
    kind: 'card-version',
    entry_id: change.entry_id,
    card_id: card.id,
    version: card.version_seq,
    committed_at: change.changed_at,
    card: ordinaryCardPayload(card),
    predecessor: fold.selection.ordinary,
    change: ordinaryChange(change),
  });
  publishFreshFile(
    cardHistoryFile(projectRoot, card.id, artifact.entry_id),
    serializeArtifact(artifact),
    temporary,
    io,
  );
  publishHeadFile(
    path,
    cardPreviousHeadFile(projectRoot, card.id),
    jsonBytes(
      cardHeadSchema.parse({
        ...fold.selection,
        head_id: randomUUID(),
        ordinary: referenceOf(artifact),
        version_seq: card.version_seq,
        updated_at: card.updated_at,
        pending: card.pending_notifications,
      }),
    ),
    'replacement',
    temporary,
    io,
  );
  return artifact;
}

export function publishCardTombstone(
  projectRoot: string,
  cardId: string,
  finalCard: CardRecord,
  change: CardVersionChange,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): CardTombstoneArtifact {
  if (cardId === 'project') throw new Error('Cannot tombstone the project card.');
  const fold = readCardArtifacts(projectRoot, cardId);
  if (fold.tombstone) throw new Error(`Card '${cardId}' is terminal.`);
  if (!valuesEqual(fold.current.card, finalCard))
    throw new Error(`Card '${cardId}' tombstone final card must equal current.`);
  const artifact = cardTombstoneArtifactSchema.parse({
    format_version: 1,
    kind: 'card-tombstone',
    entry_id: change.entry_id,
    card_id: cardId,
    version: finalCard.version_seq + 1,
    committed_at: change.changed_at,
    prior_card_version: finalCard.version_seq,
    prior_updated_at: finalCard.updated_at,
    final_card: ordinaryCardPayload(finalCard),
    predecessor: fold.selection.ordinary,
    change,
  });
  publishFreshFile(
    cardHistoryFile(projectRoot, cardId, artifact.entry_id),
    serializeArtifact(artifact),
    temporary,
    io,
  );
  publishHeadFile(
    cardHeadFile(projectRoot, cardId),
    cardPreviousHeadFile(projectRoot, cardId),
    jsonBytes(
      cardHeadSchema.parse({
        ...fold.selection,
        head_id: randomUUID(),
        ordinary: referenceOf(artifact),
        version_seq: artifact.version,
        updated_at: artifact.committed_at,
        pending: [],
      }),
    ),
    'replacement',
    temporary,
    io,
  );
  return artifact;
}

function referenceOf(artifact: CardArtifact): CardArtifactReference {
  return { entry_id: artifact.entry_id, version: artifact.version };
}
function ordinaryChange(change: CardVersionChange): CardVersionChange {
  const changed_fields = change.changed_fields.filter((field) => field !== 'pending_notifications');
  return {
    ...change,
    changed_fields,
    change_summary:
      change.kind === 'status' || change.kind === 'terminal'
        ? summarizeChangedFields(changed_fields)
        : change.change_summary,
  };
}
function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) + '\n');
}
function parseJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function serializeArtifact(artifact: CardArtifact): Buffer {
  return jsonBytes(
    artifact.kind === 'card-version'
      ? { ...artifact, card: ordinaryCardPayload(artifact.card) }
      : { ...artifact, final_card: ordinaryCardPayload(artifact.final_card) },
  );
}
