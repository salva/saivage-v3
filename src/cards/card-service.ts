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
  readCardArtifacts,
  readCardHistory,
  readCardIndex,
  type CardIdentityFactory,
} from '../persistence/card-files.js';
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
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';
import { CardHistoryReader, type CardDiffEntry } from './history-reader.js';
import type { CardNotification } from '../schemas/types.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

export type { CardDiffEntry, CardMutationContext, NewCardInput, RecordProjection };

function clone<T>(value: T): T { return structuredClone(value); }

function historyEntry(prior: CardRecord, kind: CardHistoryEntry['kind'], ctx: CardMutationContext, fields: string[], summary: string): CardHistoryEntry {
  return cardHistoryEntrySchema.parse({ entry_id: randomUUID(), kind, card_id: prior.id, version_seq: prior.version_seq, snapshot: prior, changed_at: new Date().toISOString(), changed_by_actor: ctx.actor, changed_by_surface: ctx.surface, change_reason: ctx.reason ?? null, changed_fields: fields, change_summary: summary });
}

export class CardService {
  readonly maxDepth = 5;
  private notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;

  constructor(readonly projectRoot: string, private readonly eventBus = new EventBus(), private readonly readModelChanges: ReadModelChanges = new ReadModelChangeBroadcaster(), private readonly cardIdentity: CardIdentityFactory = randomUUID) {}

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void { this.notifyCard = notifyCard; }
  cards(): CardService { return this; }
  records(): AuthoredRecordService { return new AuthoredRecordService(this); }
  get recordReader() { return { record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => this.readRecord(cardId, filename, version), cardArtifacts: (cardId: string) => readCardArtifacts(this.projectRoot, cardId) }; }
  get namespace() { return { activeCardIds: () => this.list().map((card) => card.id), isActiveCardId: (cardId: string) => this.read(cardId) !== null }; }

  private state(): CardIndex {
    const state = new CardIndex(this.maxDepth);
    for (const card of listCards(this.projectRoot).sort((left, right) => left.depth - right.depth)) state.upsert(card);
    for (const id of readCardIndex(this.projectRoot).tombstonedIds) state.addReservedId(id);
    return state;
  }

  read(id: string): CardRecord | null { return clone(this.state().get(id) ?? null); }
  list(): CardRecord[] { return clone(this.state().list()); }
  listChildren(parentId: string): string[] { return this.state().childrenOf(parentId); }
  getParent(id: string): string | null { return this.state().get(id)?.parent ?? null; }
  getAncestors(id: string): string[] { const state = this.state(); const out: string[] = []; let current = state.get(id); while (current?.parent) { out.unshift(current.parent); current = state.get(current.parent); } return out; }
  isDescendantOf(id: string, ancestorId: string): boolean { return this.getAncestors(id).includes(ancestorId); }
  getDescendantIds(id: string): string[] { const state = this.state(); const out: string[] = []; const visit = (parent: string): void => { for (const child of state.childrenOf(parent)) { out.push(child); visit(child); } }; visit(id); return out; }
  detectCycles(id: string, dependsOn: string[]): string[] { return this.state().detectDependsOnCycle(id, dependsOn); }
  blocksFor(id: string): string[] { return this.list().filter((card) => card.depends_on.includes(id)).map((card) => card.id); }
  validateTransition(from: CardStatus, to: CardStatus): void { validateTransition(from, to); }
  canTransition(from: CardStatus, to: CardStatus): boolean { return canTransition(from, to); }

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection { return readAuthoredRecord(this.projectRoot, cardId, filename, version); }
  openRecord(cardId: string, filename: string): RecordProjection { return openAuthoredRecord(this.projectRoot, cardId, filename); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return replaceOpenAuthoredRecord(this.projectRoot, cardId, filename, version, content); }
  closeRecord(cardId: string, filename: string, version: number, role: AgentRole, cardVersionSeq: number): RecordProjection { return closeAuthoredRecord(this.projectRoot, cardId, filename, version, role, cardVersionSeq); }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return discardAuthoredRecord(this.projectRoot, cardId, filename, version, reason); }

  listCardHistory(id: string): CardHistoryEntry[] { return clone(readCardHistory(this.projectRoot, id)); }
  getCardAt(id: string, versionSeq: number): CardRecord { const artifact = readCardArtifacts(this.projectRoot, id).artifacts.find((candidate) => candidate.version === versionSeq); if (!artifact) throw new Error(`Card '${id}' version ${versionSeq} not found.`); return clone(artifact.card); }
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    const reader = new CardHistoryReader({ projectRoot: this.projectRoot, read: (cardId) => this.read(cardId) });
    return reader.diffCard(id, fromSeq, toSeq);
  }

  create(input: NewCardInput): CardRecord {
    assertCanCreateCard(input);
    if (input.type === 'project') throw new Error('The fixed project card is created only by bootstrap.');
    const state = this.state();
    const parent = input.parent === null ? null : state.get(input.parent);
    if (input.parent !== null && !parent) throw new Error(`Parent card '${input.parent}' does not exist.`);
    if (parent && (isTerminalType(parent.type) || isTerminalState(parent.status))) throw new Error(`Cannot create a child under '${parent.id}'.`);
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.maxDepth) throw new Error(`Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}.`);
    const position = parent ? state.childrenOf(parent.id).length : 0;
    const timestamp = new Date().toISOString();
    const cardInput: Omit<CardRecord, 'id'> = {
      type: input.type, parent: input.parent, depth, position, title: input.title, status: input.status,
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
    const card = publishInitialCard(this.projectRoot, cardInput, briefContentForNewCard(input), input.created_by === 'planner' ? 'planner' : 'analyst', this.cardIdentity);
    this.readModelChanges.cardStateChanged();
    return clone(card);
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord { return this.applyPatch(id, changes, 'update', { actor: 'runtime', surface: 'runtime', reason: 'update' }); }
  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord { return this.applyPatch(id, changes, 'mutate', ctx); }
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord { return this.applyPatch(id, changes, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' }); }
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord { return this.applyPatch(id, changes, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle repair' }); }
  setStatus(id: string, status: CardStatus): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); if (status === 'done' || status === 'failed') throw new Error(`setStatus does not support '${status}'.`); validateTransition(card.status, status); if (card.status === status) return card; return this.applyPatch(id, { status, lifecycle: buildSetStatusLifecycle(card, status) }, 'status', { actor: 'runtime', surface: 'runtime', reason: `status -> ${status}` }); }
  enqueueNotification(id: string, notification: CardNotification): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = enqueueCardNotification(card, notification); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notification enqueued' }); }
  removeNotifications(id: string, notificationIds: readonly string[]): CardRecord { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const next = removeCardNotifications(card, notificationIds); return this.applyPatch(id, { pending_notifications: next.pending_notifications }, 'mutate', { actor: 'runtime', surface: 'runtime', reason: 'notifications delivered' }); }

  private applyPatch(id: string, changes: Partial<CardRecord>, kind: 'update' | 'status' | 'mutate' | 'depends', ctx: CardMutationContext): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    const real = prunePartialPatch(existing, changes); if (Object.keys(real).length === 0) return existing;
    const candidate = cardRecordSchema.parse(buildUpdatedCard(existing, real, new Date().toISOString(), { childCount: this.listChildren(id).length }, ctx));
    if (real.depends_on && this.detectCycles(id, candidate.depends_on).length > 0) throw new Error(`Dependency cycle detected for '${id}'.`);
    const fields = collectChangedFields(existing, candidate, real);
    const history = historyEntry(existing, kind, ctx, fields, summarizeChangedFields(fields));
    publishCardVersion(this.projectRoot, candidate, history);
    this.eventBus.emit('card_history_appended', { entry_id: history.entry_id, entry_kind: history.kind, card_id: history.card_id, version_seq: history.version_seq, changed_fields: history.changed_fields, changed_at: history.changed_at });
    this.readModelChanges.cardStateChanged();
    return clone(candidate);
  }

  updateDependsOn(id: string, dependsOn: string[], ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'dependency update' }): CardRecord { return this.applyPatch(id, { depends_on: dependsOn }, 'depends', ctx); }
  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): { ok: true; changed: number } | { ok: false; reason: string; missing: string[]; extra: string[] } {
    const actual = this.listChildren(parentId); if (actual.length !== orderedChildIds.length || actual.some((id) => !orderedChildIds.includes(id))) return { ok: false, reason: 'ordered child ids do not match current children', missing: actual.filter((id) => !orderedChildIds.includes(id)), extra: orderedChildIds.filter((id) => !actual.includes(id)) };
    let changed = 0; orderedChildIds.forEach((id, position) => { const card = this.read(id)!; if (card.position !== position) { this.applyPatch(id, { position }, 'mutate', ctx); changed += 1; } }); return { ok: true, changed };
  }
  delete(id: string): void { const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`); const entry = historyEntry(card, 'delete', { actor: 'runtime', surface: 'runtime', reason: 'delete' }, ['__deleted__'], 'card deleted'); publishCardTombstone(this.projectRoot, id, card, entry); }
  archiveAndDeleteSubtree(ids: string[]): void { for (const id of [...ids].reverse()) this.delete(id); }
}

export class AuthoredRecordService {
  constructor(private readonly cards: CardService) {}
  get projectRoot(): string { return this.cards.projectRoot; }
  read(id: string): CardRecord | null { return this.cards.read(id); }
  getAncestors(id: string): string[] { return this.cards.getAncestors(id); }
  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection { return this.cards.readRecord(cardId, filename, version); }
  openRecord(cardId: string, filename: string): RecordProjection { return this.cards.openRecord(cardId, filename); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return this.cards.editRecord(cardId, filename, version, content); }
  closeRecord(cardId: string, filename: string, version: number, role: AgentRole, cardVersionSeq: number): RecordProjection { return this.cards.closeRecord(cardId, filename, version, role, cardVersionSeq); }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return this.cards.discardRecord(cardId, filename, version, reason); }
  listCardHistory(id: string): CardHistoryEntry[] { return this.cards.listCardHistory(id); }
  getCardAt(id: string, versionSeq: number): CardRecord { return this.cards.getCardAt(id, versionSeq); }
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] { return this.cards.diffCard(id, fromSeq, toSeq); }
}

export { CardServiceInvariantError } from './errors.js';
