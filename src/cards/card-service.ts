import { randomUUID } from 'node:crypto';

import { EventBus } from '../events/index.js';
import {
  cardHistoryEntrySchema,
  cardLifecycleStateSchema,
  cardRecordSchema,
  positiveSafeIntegerSchema,
  type AgentRole,
  type CardHistoryEntry,
  type CardRecord,
  type CardStatus,
} from '../schemas/index.js';
import {
  closeAuthoredRecord,
  discardAuthoredRecord,
  openAuthoredRecord,
  readAuthoredRecord,
  replaceOpenAuthoredRecord,
  type RecordProjection,
} from '../persistence/authored-record-files.js';
import {
  listCards,
  publishCardTombstone,
  publishCardVersion,
  publishInitialCard,
  proveCreatedCardPublication,
  readCard,
  readCardArtifacts,
  readCanonicalCard,
  readCanonicalCardHierarchy,
  readCanonicalCardFileContent,
  readCanonicalCardFilesMetadata,
  readCardDetail,
  readCardDiffIndex,
  readCardHierarchy,
  readCardHistoryEntry,
  readCardHistoryList,
  readLinkedChildren,
  readLinkedChildrenProjection,
  type CardTargetRead,
  type CanonicalCardProjection,
  type CanonicalLinkedChildrenProjection,
  type CanonicalCardFileContentRead,
  type CanonicalCardFileSlot,
  type CanonicalCardFilesMetadataProjection,
} from '../persistence/card-files.js';
import type { CanonicalReadInstrumentation, GrowingFileIo } from '../persistence/growing-file.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { ReadModelChangeBroadcaster } from '../application/read-model-changes.js';
import type { LiveSyncCardRecordSlot } from '../contracts/index.js';
import { CardIndex } from './card-index.js';
import {
  assertCanCreateCard,
  assertGenericCardPatch,
  briefContentForNewCard,
  buildSetStatusLifecycle,
  buildActivatedStoppedLifecycle,
  buildStoppedLifecycle,
  buildUpdatedCard,
  canTransition,
  collectChangedFields,
  enqueueCardNotification,
  isTerminalType,
  prunePartialPatch,
  removeCardNotifications,
  summarizeChangedFields,
  validateTransition,
  type CardPatch,
  type CardMutationContext,
  type NewCardInput,
  type TerminalLifecyclePatch,
} from './lifecycle.js';
import { canCreateChildInStatus } from './card-status.js';
import { valuesEqual } from './value-equality.js';
import type { CardNotification } from '../schemas/types.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { CardServiceInvariantError } from './errors.js';

export type CardActivationAdmissionProjection = {
  child: CardRecord;
  dependencies: Array<{ id: string; status: CardStatus }>;
};

export interface CardDiffEntry { field: string; before: unknown; after: unknown }
export type CardHistoryListResult = CardTargetRead<CardHistoryEntry[]>;
export type CardServiceTargetRead<T> = CardTargetRead<T>;
export type CanonicalCardReadProjection = CanonicalCardProjection;
export type CanonicalCardChildrenReadProjection = CanonicalLinkedChildrenProjection;
export type CanonicalCardFilesMetadataReadProjection = CanonicalCardFilesMetadataProjection;
export type { CanonicalCardFileContentRead, CanonicalCardFileSlot };
export type CardHistoryEntryResult = CardTargetRead<CardHistoryEntry> | { readonly kind: 'history-entry-not-found'; readonly versionSeq: number };
export type CardHistoryDiffResult =
  | { readonly kind: 'found'; readonly from: number; readonly to: number; readonly diff: CardDiffEntry[] }
  | { readonly kind: 'card-not-found' }
  | { readonly kind: 'invalid-pivots'; readonly from: number; readonly to: number }
  | { readonly kind: 'diff-source-not-found'; readonly from: number; readonly to: number; readonly missingVersionSeq: number };

export type { CardMutationContext, CardPatch, NewCardInput, RecordProjection, TerminalLifecyclePatch };

type CardWriteIntent =
  | { kind: 'ordinary' }
  | { kind: 'set-status'; status: CardStatus }
  | { kind: 'terminal-lifecycle-commit' }
  | { kind: 'recovery-stop' }
  | { kind: 'stopped-activation' };

const LIFECYCLE_FIELDS = new Set(['status', 'lifecycle']);
const TERMINAL_PATCH_FIELDS = new Set(['status', 'lifecycle', 'status_text', 'status_text_updated_at']);

function clone<T>(value: T): T { return structuredClone(value); }

function diffSnapshots(from: CardRecord, to: CardRecord): CardDiffEntry[] {
  const fields = new Set<keyof CardRecord>([
    ...(Object.keys(from) as Array<keyof CardRecord>),
    ...(Object.keys(to) as Array<keyof CardRecord>),
  ]);
  return [...fields]
    .filter((field) => !valuesEqual(from[field], to[field]))
    .map((field) => ({ field, before: from[field], after: to[field] }));
}

function historyEntry(prior: CardRecord, kind: CardHistoryEntry['kind'], ctx: CardMutationContext, fields: string[], summary: string): CardHistoryEntry {
  return cardHistoryEntrySchema.parse({ entry_id: randomUUID(), kind, card_id: prior.id, version_seq: prior.version_seq, snapshot: prior, changed_at: new Date().toISOString(), changed_by_actor: ctx.actor, changed_by_surface: ctx.surface, change_reason: ctx.reason ?? null, changed_fields: fields, change_summary: summary });
}

function assertChildParentAdmission(parent: CardRecord, message: string): void {
  if (isTerminalType(parent.type) || !canCreateChildInStatus(parent.status)) throw new Error(`${message} '${parent.id}'.`);
}

function assertExactPatchKeys(changes: CardPatch, expected: ReadonlySet<string>, operation: string): void {
  const keys = Object.keys(changes);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${operation} requires exactly fields ${[...expected].join(', ')}.`);
  }
}

function unreachableIntent(intent: never): never {
  throw new Error(`Unsupported card write intent: ${String(intent)}`);
}

function assertCardWriteIntent(existing: CardRecord, changes: CardPatch, intent: CardWriteIntent): void {
  switch (intent.kind) {
    case 'ordinary': {
      const fields = Object.keys(changes).filter((key) => LIFECYCLE_FIELDS.has(key));
      if (fields.length > 0) throw new Error(`Fields ${fields.join(', ')} are lifecycle-owned and require a dedicated lifecycle operation.`);
      return;
    }
    case 'set-status': {
      assertExactPatchKeys(changes, LIFECYCLE_FIELDS, 'setStatus');
      if (changes.status !== intent.status || !valuesEqual(changes.lifecycle, buildSetStatusLifecycle(existing, intent.status))) {
        throw new Error('setStatus patch does not match its target status and canonical lifecycle.');
      }
      validateTransition(existing.status, intent.status);
      return;
    }
    case 'recovery-stop':
      if (existing.status !== 'running') throw new Error(`Card '${existing.id}' must be running before recovery can stop it.`);
      assertExactPatchKeys(changes, LIFECYCLE_FIELDS, 'Recovery stop');
      if (changes.status !== 'stopped' || !valuesEqual(changes.lifecycle, buildStoppedLifecycle())) throw new Error('Recovery stop requires the canonical stopped lifecycle.');
      return;
    case 'stopped-activation':
      if (existing.status !== 'stopped') throw new Error(`Card '${existing.id}' must be stopped before it can be activated through STOPPED.`);
      assertExactPatchKeys(changes, LIFECYCLE_FIELDS, 'STOPPED activation');
      if (changes.status !== 'running' || !valuesEqual(changes.lifecycle, buildActivatedStoppedLifecycle())) throw new Error('STOPPED activation requires the canonical running lifecycle.');
      return;
    case 'terminal-lifecycle-commit': {
      if (existing.status !== 'running') throw new Error(`Card '${existing.id}' must be running before terminal lifecycle commit.`);
      const keys = Object.keys(changes);
      if (!Object.hasOwn(changes, 'status') || !Object.hasOwn(changes, 'lifecycle') || keys.some((key) => !TERMINAL_PATCH_FIELDS.has(key))) {
        throw new Error('Terminal lifecycle commit requires status and lifecycle and permits only status-text companions.');
      }
      if (changes.status !== 'done' && changes.status !== 'failed' && changes.status !== 'blocked') {
        throw new Error(`Terminal lifecycle commit does not support target '${String(changes.status)}'.`);
      }
      const lifecycle = cardLifecycleStateSchema.parse(changes.lifecycle);
      if (lifecycle.status !== changes.status) throw new Error(`Terminal lifecycle status '${lifecycle.status}' does not match target '${changes.status}'.`);
      return;
    }
    default:
      return unreachableIntent(intent);
  }
}

export class CardService {
  readonly maxDepth = 5;
  private notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;

  constructor(readonly projectRoot: string, private readonly eventBus = new EventBus(), private readonly readModelChanges: ReadModelChanges = new ReadModelChangeBroadcaster(), private readonly cardAppendIo?: GrowingFileIo) {}

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void { this.notifyCard = notifyCard; }
  get recordReader() { return { record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => this.readRecord(cardId, filename, version), cardArtifacts: (cardId: string) => readCardArtifacts(this.projectRoot, cardId) }; }

  private state(): CardIndex {
    const state = new CardIndex();
    for (const card of listCards(this.projectRoot).sort((left, right) => left.depth - right.depth)) state.upsert(card);
    return state;
  }

  private publishCardVersionEffects(history: CardHistoryEntry, parentId: string | null, runtimeChanged: boolean, recordSlots: readonly LiveSyncCardRecordSlot[] = []): void {
    this.eventBus.emit('card_history_appended', { entry_id: history.entry_id, entry_kind: history.kind, card_id: history.card_id, version_seq: history.version_seq, changed_fields: history.changed_fields, changed_at: history.changed_at });
    const cardId = history.card_id;
    this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: cardId });
    this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'history', card_id: cardId });
    this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'diff', card_id: cardId });
    this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: cardId });
    if (parentId) this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: parentId });
    for (const slot of recordSlots) this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, slot });
    if (runtimeChanged) this.readModelChanges.runtimeChanged();
  }

  readActivationAdmission(cardId: string): CardActivationAdmissionProjection | null {
    const child = this.read(cardId);
    if (!child) return null;
    const dependencies = child.depends_on.map((id) => {
      const dependency = this.read(id);
      if (!dependency) throw new CardServiceInvariantError(`Card '${child.id}' depends_on missing card '${id}'.`);
      return { id, status: dependency.status };
    });
    return clone({ child, dependencies });
  }

  read(id: string): CardRecord | null { const card = readCard(this.projectRoot, id); return card ? clone(card) : null; }
  list(): CardRecord[] { return clone(this.state().list()); }
  listChildren(parentId: string): string[] { return readLinkedChildren(this.projectRoot, parentId).map((card) => card.id); }
  getParent(id: string): string | null { return this.state().get(id)?.parent ?? null; }
  getAncestors(id: string): string[] { const state = this.state(); const out: string[] = []; let current = state.get(id); while (current?.parent) { out.unshift(current.parent); current = state.get(current.parent); } return out; }
  isDescendantOf(id: string, ancestorId: string): boolean { return this.getAncestors(id).includes(ancestorId); }
  getDescendantIds(id: string): string[] { const state = this.state(); const out: string[] = []; const visit = (parent: string): void => { for (const child of state.childrenOf(parent)) { out.push(child); visit(child); } }; visit(id); return out; }
  detectCycles(id: string, dependsOn: string[]): string[] { return this.state().detectDependsOnCycle(id, dependsOn); }
  blocksFor(id: string): string[] { return this.list().filter((card) => card.depends_on.includes(id)).map((card) => card.id); }
  validateTransition(from: CardStatus, to: CardStatus): void { validateTransition(from, to); }
  canTransition(from: CardStatus, to: CardStatus): boolean { return canTransition(from, to); }

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest', instrumentation?: CanonicalReadInstrumentation): RecordProjection { return readAuthoredRecord(this.projectRoot, cardId, filename, version, instrumentation); }
  openRecord(cardId: string, filename: string): RecordProjection { return openAuthoredRecord(this.projectRoot, cardId, filename, undefined, this.cardAppendIo); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return replaceOpenAuthoredRecord(this.projectRoot, cardId, filename, version, content, this.cardAppendIo); }
  closeRecord(cardId: string, filename: string, version: number, role: AgentRole, cardVersionSeq: number): RecordProjection {
    const closed = closeAuthoredRecord(this.projectRoot, cardId, filename, version, role, cardVersionSeq, this.cardAppendIo);
    this.readModelChanges.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, slot: closed.slot });
    return closed;
  }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return discardAuthoredRecord(this.projectRoot, cardId, filename, version, reason, this.cardAppendIo); }

  getCardDetail(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> {
    return clone(readCardDetail(this.projectRoot, id, instrumentation));
  }
  getCanonicalCard(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardReadProjection> {
    return readCanonicalCard(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardChildren(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardChildrenReadProjection> {
    return readCanonicalCardHierarchy(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardFilesMetadata(id: string): CardTargetRead<CanonicalCardFilesMetadataReadProjection> {
    return readCanonicalCardFilesMetadata(this.projectRoot, id);
  }
  getCanonicalCardFileContent(id: string, slot: CanonicalCardFileSlot, maximumBytes: number): CanonicalCardFileContentRead {
    return readCanonicalCardFileContent(this.projectRoot, id, slot, maximumBytes);
  }
  getCardChildren(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<{ parent: CardRecord; activeChildren: CardRecord[] }> {
    return clone(readCardHierarchy(this.projectRoot, id, instrumentation));
  }
  listCardHistory(id: string, instrumentation?: CanonicalReadInstrumentation): CardHistoryListResult {
    return clone(readCardHistoryList(this.projectRoot, id, instrumentation));
  }
  getCardHistoryEntry(id: string, versionSeq: number, instrumentation?: CanonicalReadInstrumentation): CardHistoryEntryResult {
    positiveSafeIntegerSchema.parse(versionSeq);
    return clone(readCardHistoryEntry(this.projectRoot, id, versionSeq, instrumentation));
  }
  diffCardHistory(id: string, pivots: { fromSeq?: number | 'last' | 'current'; toSeq?: number | 'last' | 'current' }, instrumentation?: CanonicalReadInstrumentation): CardHistoryDiffResult {
    const validatePivot = (pivot: number | 'last' | 'current' | undefined): void => {
      if (pivot !== undefined && pivot !== 'last' && pivot !== 'current') positiveSafeIntegerSchema.parse(pivot);
    };
    validatePivot(pivots.fromSeq);
    validatePivot(pivots.toSeq);
    const target = readCardDiffIndex(this.projectRoot, id, instrumentation);
    if (target.kind === 'card-not-found') return target;
    const current = target.value.current.card.version_seq;
    const resolve = (pivot: number | 'last' | 'current' | undefined, fallback: number): number => typeof pivot === 'number' ? pivot : pivot === undefined ? fallback : current;
    const to = resolve(pivots.toSeq, current);
    const from = resolve(pivots.fromSeq, Math.max(1, to - 1));
    if (from > to) return { kind: 'invalid-pivots', from, to };
    const fromCard = target.value.artifacts.find((artifact) => artifact.version === from)?.card;
    const toCard = target.value.artifacts.find((artifact) => artifact.version === to)?.card;
    if (!fromCard || !toCard) return { kind: 'diff-source-not-found', from, to, missingVersionSeq: !fromCard ? from : to };
    return { kind: 'found', from, to, diff: clone(diffSnapshots(fromCard, toCard)) };
  }

  create(input: NewCardInput): CardRecord {
    assertCanCreateCard(input);
    if (input.type === 'project') throw new Error('The fixed project card is created only by bootstrap.');
    const parent = this.read(input.parent);
    if (!parent) throw new Error(`Parent card '${input.parent}' does not exist.`);
    assertChildParentAdmission(parent, 'Cannot create a child under');
    const depth = parent.depth + 1;
    if (depth > this.maxDepth) throw new Error(`Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}.`);
    for (const dependencyId of input.depends_on) if (!this.read(dependencyId)) throw new Error(`Dependency card '${dependencyId}' does not exist.`);
    const parentBeforeClaim = this.read(parent.id);
    if (!parentBeforeClaim) throw new Error(`Parent '${parent.id}' changed before child namespace claim.`);
    assertChildParentAdmission(parentBeforeClaim, 'Cannot claim a child namespace under');
    const timestamp = new Date().toISOString();
    const cardInput: Omit<CardRecord, 'id'> = {
      type: input.type, parent: parentBeforeClaim.id, depth: parentBeforeClaim.depth + 1, children: [], title: input.title, status: input.status,
      subtype: input.subtype ?? null, tags: input.tags, priority: input.priority, urgency: input.urgency,
      created_by: input.created_by, created_at: timestamp, updated_at: timestamp, version_seq: 1,
      assigned_to: input.assigned_to ?? null, depends_on: input.depends_on, related: input.related,
      lifecycle: input.lifecycle ?? ({ status: input.status, result: null, error: null, completed_at: null } as CardRecord['lifecycle']),
      metrics: input.metrics ?? null, estimate: input.estimate ?? null, started_at: input.started_at ?? null,
      duration_ms: input.duration_ms ?? null, status_text: input.status_text ?? null,
      status_text_updated_at: input.status_text_updated_at ?? null,
      status_text_author_session_id: input.status_text_author_session_id ?? null,
      latest_self_report: input.latest_self_report ?? null, metadata: input.metadata ?? null,
      pending_notifications: [],
    };
    const card = publishInitialCard(this.projectRoot, cardInput, briefContentForNewCard(input), input.created_by === 'planner' ? 'planner' : 'analyst');
    const freshParent = this.read(parent.id);
    if (!freshParent || freshParent.children.includes(card.id)) throw new Error(`Parent '${parent.id}' changed during child publication.`);
    assertChildParentAdmission(freshParent, 'Cannot link a child under');
    proveCreatedCardPublication(this.projectRoot, card);
    const linked = cardRecordSchema.parse({ ...freshParent, children: [...freshParent.children, card.id], version_seq: freshParent.version_seq + 1, updated_at: new Date().toISOString() });
    const linkHistory = historyEntry(freshParent, 'child_link', { actor: input.created_by, surface: 'runtime', reason: 'child linked' }, ['children'], `linked child ${card.id}`);
    publishCardVersion(this.projectRoot, linked, linkHistory, this.cardAppendIo);
    this.publishCardVersionEffects(linkHistory, freshParent.parent, true);
    return clone(card);
  }

  update(id: string, changes: CardPatch): CardRecord { return this.applyPatch(id, changes, 'update', { actor: 'runtime', surface: 'runtime', reason: 'update' }, { kind: 'ordinary' }); }
  mutateCard(id: string, changes: CardPatch, ctx: CardMutationContext): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (changes.status !== undefined && ((card.status === 'running' && changes.status === 'stopped') || (card.status === 'stopped' && changes.status === 'running'))) {
      throw new Error(`Generic card mutation cannot transition '${card.status}' to '${changes.status}'.`);
    }
    return this.applyPatch(id, changes, 'mutate', ctx, { kind: 'ordinary' });
  }
  commitTerminalLifecyclePatch(id: string, changes: TerminalLifecyclePatch): CardRecord { return this.applyPatch(id, changes, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' }, { kind: 'terminal-lifecycle-commit' }); }
  setStatus(id: string, status: CardStatus): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); if (status === 'done' || status === 'failed') throw new Error(`setStatus does not support '${status}'.`); validateTransition(card.status, status); if (card.status === status) return card; return this.applyPatch(id, { status, lifecycle: buildSetStatusLifecycle(card, status) }, 'status', { actor: 'runtime', surface: 'runtime', reason: `status -> ${status}` }, { kind: 'set-status', status }); }
  stopRunningForRecovery(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.status !== 'running') throw new Error(`Card '${id}' must be running before recovery can stop it.`);
    return this.applyPatch(id, { status: 'stopped', lifecycle: buildStoppedLifecycle() }, 'status', { actor: 'runtime', surface: 'runtime', reason: 'recovery stopped lifecycle' }, { kind: 'recovery-stop' });
  }
  activateStopped(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.status !== 'stopped') throw new Error(`Card '${id}' must be stopped before it can be activated through STOPPED.`);
    return this.applyPatch(id, { status: 'running', lifecycle: buildActivatedStoppedLifecycle() }, 'status', { actor: 'runtime', surface: 'runtime', reason: 'STOPPED activation' }, { kind: 'stopped-activation' });
  }
  enqueueNotification(id: string, notification: CardNotification): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = enqueueCardNotification(card, notification); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notification enqueued' }, { kind: 'ordinary' }); }
  removeNotifications(id: string, notificationIds: readonly string[]): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = removeCardNotifications(card, notificationIds); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notifications delivered' }, { kind: 'ordinary' }); }

  private applyPatch(id: string, changes: CardPatch, kind: 'update' | 'status' | 'mutate' | 'depends', ctx: CardMutationContext, intent: CardWriteIntent): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    assertGenericCardPatch(changes);
    const real = prunePartialPatch(existing, changes);
    assertCardWriteIntent(existing, real, intent);
    if (Object.keys(real).length === 0) return existing;
    const candidate = cardRecordSchema.parse(buildUpdatedCard(existing, real, new Date().toISOString()));
    if (real.depends_on && this.detectCycles(id, candidate.depends_on).length > 0) throw new Error(`Dependency cycle detected for '${id}'.`);
    const fields = collectChangedFields(existing, candidate, real);
    const history = historyEntry(existing, kind, ctx, fields, summarizeChangedFields(fields));
    publishCardVersion(this.projectRoot, candidate, history, this.cardAppendIo);
    this.publishCardVersionEffects(history, existing.parent, Object.hasOwn(real, 'status'));
    return clone(candidate);
  }

  updateDependsOn(id: string, dependsOn: string[], ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'dependency update' }): CardRecord { return this.applyPatch(id, { depends_on: dependsOn }, 'depends', ctx, { kind: 'ordinary' }); }
  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): { ok: true; changed: number } | { ok: false; reason: string; missing: string[]; extra: string[] } {
    const { parent, activeChildren } = readLinkedChildrenProjection(this.projectRoot, parentId);
    const actual = activeChildren.map((card) => card.id);
    const actualSet = new Set(actual);
    const requestedSet = new Set(orderedChildIds);
    if (actual.length !== orderedChildIds.length || requestedSet.size !== orderedChildIds.length || actual.some((id) => !requestedSet.has(id))) {
      return { ok: false, reason: 'ordered child ids do not match current children', missing: actual.filter((id) => !requestedSet.has(id)), extra: orderedChildIds.filter((id) => !actualSet.has(id)) };
    }
    const changed = orderedChildIds.reduce((count, id, index) => count + (actual[index] === id ? 0 : 1), 0);
    if (changed === 0) return { ok: true, changed: 0 };
    const retained = parent.children.filter((id) => !actualSet.has(id));
    const candidate = cardRecordSchema.parse({
      ...parent,
      children: [...orderedChildIds, ...retained],
      version_seq: parent.version_seq + 1,
      updated_at: new Date().toISOString(),
    });
    const history = historyEntry(parent, 'mutate', { ...ctx, reason: ctx.reason ?? 'children reordered' }, ['children'], 'children reordered');
    publishCardVersion(this.projectRoot, candidate, history, this.cardAppendIo);
    this.publishCardVersionEffects(history, parent.parent, false);
    return { ok: true, changed };
  }
  deleteSubtrees(requestedIds: readonly string[], ctx: CardMutationContext, allowed: (card: CardRecord) => boolean): { deleted: string[]; requested: string[] } {
    if (requestedIds.length === 0) throw new Error('Deletion requires at least one card id.');
    const state = this.state(); const roots = [...new Set(requestedIds)]; const intended = new Set<string>();
    for (const id of roots) { const card = state.get(id); if (!card || id === 'project') throw new Error(`Card '${id}' cannot be deleted.`); intended.add(id); for (const child of state.descendantsOf(id)) intended.add(child); }
    for (const id of intended) if (!allowed(state.get(id)!)) throw new Error(`Deletion denied for card '${id}'.`);
    for (const survivor of state.list()) for (const dependency of survivor.depends_on) if (!intended.has(survivor.id) && intended.has(dependency)) throw new Error(`Surviving card '${survivor.id}' depends on deleted card '${dependency}'.`);
    const outgoing = new Map<string, Set<string>>([...intended].map((id) => [id, new Set()])); const indegree = new Map<string, number>([...intended].map((id) => [id, 0]));
    const edge = (from: string, to: string): void => { const set = outgoing.get(from)!; if (!set.has(to)) { set.add(to); indegree.set(to, indegree.get(to)! + 1); } };
    for (const id of intended) { const card = state.get(id)!; if (card.parent && intended.has(card.parent)) edge(id, card.parent); for (const dependency of card.depends_on) if (intended.has(dependency)) edge(id, dependency); }
    const ready = [...intended].filter((id) => indegree.get(id) === 0).sort(); const order: string[] = [];
    while (ready.length) { const id = ready.shift()!; order.push(id); for (const next of outgoing.get(id)!) { indegree.set(next, indegree.get(next)! - 1); if (indegree.get(next) === 0) { ready.push(next); ready.sort(); } } }
    if (order.length !== intended.size) throw new Error('Deletion dependency and hierarchy constraints conflict.');
    for (const id of order) { const card = state.get(id)!; const entry = historyEntry(card, 'delete', ctx, ['__deleted__'], 'card deleted'); publishCardTombstone(this.projectRoot, id, card, entry, this.cardAppendIo); this.publishCardVersionEffects(entry, card.parent, true, ['brief', 'status', 'review']); }
    return { deleted: order, requested: roots };
  }
}

export { CardServiceInvariantError } from './errors.js';
