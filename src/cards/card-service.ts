import { randomUUID } from 'node:crypto';

import { EventBus } from '../events/index.js';
import {
  cardHistoryEntrySchema,
  cardRecordSchema,
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
  readCardHistory,
  readLinkedChildren,
} from '../persistence/card-files.js';
import type { GrowingFileIo } from '../persistence/growing-file.js';
import type { ReadModelChanges } from '../application/read-model-changes.js';
import { ReadModelChangeBroadcaster } from '../application/read-model-changes.js';
import { CardIndex } from './card-index.js';
import {
  assertCanCreateCard,
  briefContentForNewCard,
  buildSetStatusLifecycle,
  buildUpdatedCard,
  canTransition,
  collectChangedFields,
  enqueueCardNotification,
  isTerminalState,
  isTerminalType,
  prunePartialPatch,
  removeCardNotifications,
  summarizeChangedFields,
  validateTransition,
  type CardPatch,
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';
import { CardHistoryReader, type CardDiffEntry } from './history-reader.js';
import type { CardNotification } from '../schemas/types.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { CardServiceInvariantError } from './errors.js';

export type CardActivationAdmissionProjection = {
  child: CardRecord;
  dependencies: Array<{ id: string; status: CardStatus }>;
};

export type { CardDiffEntry, CardMutationContext, CardPatch, NewCardInput, RecordProjection };

function clone<T>(value: T): T { return structuredClone(value); }

function historyEntry(prior: CardRecord, kind: CardHistoryEntry['kind'], ctx: CardMutationContext, fields: string[], summary: string): CardHistoryEntry {
  return cardHistoryEntrySchema.parse({ entry_id: randomUUID(), kind, card_id: prior.id, version_seq: prior.version_seq, snapshot: prior, changed_at: new Date().toISOString(), changed_by_actor: ctx.actor, changed_by_surface: ctx.surface, change_reason: ctx.reason ?? null, changed_fields: fields, change_summary: summary });
}

function assertChildParentAdmission(parent: CardRecord, message: string): void {
  if (isTerminalType(parent.type) || isTerminalState(parent.status)) throw new Error(`${message} '${parent.id}'.`);
}

export class CardService {
  readonly maxDepth = 5;
  private notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;

  constructor(readonly projectRoot: string, private readonly eventBus = new EventBus(), private readonly readModelChanges: ReadModelChanges = new ReadModelChangeBroadcaster(), private readonly cardAppendIo?: GrowingFileIo) {}

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void { this.notifyCard = notifyCard; }
  cards(): CardService { return this; }
  get recordReader() { return { record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => this.readRecord(cardId, filename, version), cardArtifacts: (cardId: string) => readCardArtifacts(this.projectRoot, cardId) }; }
  get namespace() { return { activeCardIds: () => this.list().map((card) => card.id), isActiveCardId: (cardId: string) => this.read(cardId) !== null }; }

  private state(): CardIndex {
    const state = new CardIndex();
    for (const card of listCards(this.projectRoot).sort((left, right) => left.depth - right.depth)) state.upsert(card);
    return state;
  }

  private publishHistoryEffects(history: CardHistoryEntry, runtimeChanged: boolean): void {
    this.eventBus.emit('card_history_appended', { entry_id: history.entry_id, entry_kind: history.kind, card_id: history.card_id, version_seq: history.version_seq, changed_fields: history.changed_fields, changed_at: history.changed_at });
    this.readModelChanges.cardStateChanged();
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

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection { return readAuthoredRecord(this.projectRoot, cardId, filename, version); }
  openRecord(cardId: string, filename: string): RecordProjection { return openAuthoredRecord(this.projectRoot, cardId, filename, undefined, this.cardAppendIo); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return replaceOpenAuthoredRecord(this.projectRoot, cardId, filename, version, content, this.cardAppendIo); }
  closeRecord(cardId: string, filename: string, version: number, role: AgentRole, cardVersionSeq: number): RecordProjection { return closeAuthoredRecord(this.projectRoot, cardId, filename, version, role, cardVersionSeq, this.cardAppendIo); }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return discardAuthoredRecord(this.projectRoot, cardId, filename, version, reason, this.cardAppendIo); }

  listCardHistory(id: string): CardHistoryEntry[] { return clone(readCardHistory(this.projectRoot, id)); }
  getCardAt(id: string, versionSeq: number): CardRecord { const artifact = readCardArtifacts(this.projectRoot, id).artifacts.find((candidate) => candidate.version === versionSeq); if (!artifact) throw new Error(`Card '${id}' version ${versionSeq} not found.`); return clone(artifact.card); }
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    const reader = new CardHistoryReader({ projectRoot: this.projectRoot });
    return reader.diffCard(id, fromSeq, toSeq);
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
    const children = readLinkedChildren(this.projectRoot, parentBeforeClaim.id);
    const position = children.length === 0 ? 0 : Math.max(...children.map((card) => card.position)) + 1;
    const timestamp = new Date().toISOString();
    const cardInput: Omit<CardRecord, 'id'> = {
      type: input.type, parent: parentBeforeClaim.id, depth: parentBeforeClaim.depth + 1, position, children: [], title: input.title, status: input.status,
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
    this.publishHistoryEffects(linkHistory, true);
    return clone(card);
  }

  update(id: string, changes: CardPatch): CardRecord { return this.applyPatch(id, changes, 'update', { actor: 'runtime', surface: 'runtime', reason: 'update' }); }
  mutateCard(id: string, changes: CardPatch, ctx: CardMutationContext): CardRecord { return this.applyPatch(id, changes, 'mutate', ctx); }
  commitTerminalLifecyclePatch(id: string, changes: CardPatch): CardRecord { return this.applyPatch(id, changes, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' }); }
  setStatus(id: string, status: CardStatus): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); if (status === 'done' || status === 'failed') throw new Error(`setStatus does not support '${status}'.`); validateTransition(card.status, status); if (card.status === status) return card; return this.applyPatch(id, { status, lifecycle: buildSetStatusLifecycle(card, status) }, 'status', { actor: 'runtime', surface: 'runtime', reason: `status -> ${status}` }); }
  enqueueNotification(id: string, notification: CardNotification): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = enqueueCardNotification(card, notification); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notification enqueued' }); }
  removeNotifications(id: string, notificationIds: readonly string[]): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = removeCardNotifications(card, notificationIds); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notifications delivered' }); }

  private applyPatch(id: string, changes: CardPatch, kind: 'update' | 'status' | 'mutate' | 'depends', ctx: CardMutationContext): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    const real = prunePartialPatch(existing, changes); if (Object.keys(real).length === 0) return existing;
    const candidate = cardRecordSchema.parse(buildUpdatedCard(existing, real, new Date().toISOString(), ctx));
    if (real.depends_on && this.detectCycles(id, candidate.depends_on).length > 0) throw new Error(`Dependency cycle detected for '${id}'.`);
    const fields = collectChangedFields(existing, candidate, real);
    const history = historyEntry(existing, kind, ctx, fields, summarizeChangedFields(fields));
    publishCardVersion(this.projectRoot, candidate, history, this.cardAppendIo);
    this.publishHistoryEffects(history, Object.hasOwn(real, 'status'));
    return clone(candidate);
  }

  updateDependsOn(id: string, dependsOn: string[], ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'dependency update' }): CardRecord { return this.applyPatch(id, { depends_on: dependsOn }, 'depends', ctx); }
  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): { ok: true; changed: number } | { ok: false; reason: string; missing: string[]; extra: string[] } {
    const children = readLinkedChildren(this.projectRoot, parentId);
    const actual = children.map((card) => card.id); if (actual.length !== orderedChildIds.length || actual.some((id) => !orderedChildIds.includes(id))) return { ok: false, reason: 'ordered child ids do not match current children', missing: actual.filter((id) => !orderedChildIds.includes(id)), extra: orderedChildIds.filter((id) => !actual.includes(id)) };
    const childrenById = new Map(children.map((card) => [card.id, card]));
    let changed = 0;
    orderedChildIds.forEach((id, position) => {
      const existing = childrenById.get(id)!;
      if (existing.position === position) return;
      const candidate = cardRecordSchema.parse(buildUpdatedCard(existing, { position }, new Date().toISOString(), ctx));
      const history = historyEntry(existing, 'mutate', ctx, ['position'], 'position updated');
      publishCardVersion(this.projectRoot, candidate, history, this.cardAppendIo);
      this.publishHistoryEffects(history, false);
      changed += 1;
    });
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
    for (const id of order) { const card = state.get(id)!; const entry = historyEntry(card, 'delete', ctx, ['__deleted__'], 'card deleted'); publishCardTombstone(this.projectRoot, id, card, entry, this.cardAppendIo); this.publishHistoryEffects(entry, true); }
    return { deleted: order, requested: roots };
  }
}

export { CardServiceInvariantError } from './errors.js';
