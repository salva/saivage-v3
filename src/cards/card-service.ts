import { randomUUID } from 'node:crypto';

import {
  cardHistoryEntrySchema,
  cardRecordSchema,
  positiveSafeIntegerSchema,
  type AgentName,
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
import type { RecordDefinition } from '../records/record-definition.js';
import { AuthoredRecordDefinitionNotFoundError, AuthoredRecordNotFoundError } from '../persistence/authored-record-files.js';
import type { CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import {
  listCards,
  publishCardTombstone,
  publishCardVersion,
  publishInitialChildCard,
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
import { NO_FRESHNESS_EFFECTS, type FreshnessEffects } from '../application/freshness-effects.js';
import type { LiveSyncCardRecordName } from '../contracts/index.js';
import { CardIndex } from './card-index.js';
import {
  assertSetStatusAdmission,
  buildSetStatusLifecycle,
  buildActivatedStoppedLifecycle,
  buildStoppedLifecycle,
  buildEditedCard,
  collectEditChangedFields,
  enqueueCardNotification,
  pruneCardEditPatch,
  removeCardNotifications,
  summarizeChangedFields,
  type CardEditPatch,
  type NewChildCardInput,
  type SetStatusTarget,
} from './lifecycle.js';
import { canCreateChildInStatus } from './card-status.js';
import { valuesEqual } from './value-equality.js';
import type { CardNotification } from '../schemas/types.js';
import { CardServiceInvariantError } from './errors.js';
import { cardDepth, cardParentId } from '../schemas/card-id.js';
import type { CardActivationOutcome } from '../contracts/tool-api.js';

export type CardActivationAdmissionProjection = {
  child: CardRecord;
  dependencies: Array<{ id: string; status: CardStatus }>;
};

export interface CardDiffEntry { field: string; before: unknown; after: unknown }
export type CardHistoryListResult = CardTargetRead<CardHistoryEntry[]>;
export type { CanonicalCardFileContentRead, CanonicalCardFileSlot };
export type CardHistoryEntryResult = CardTargetRead<CardHistoryEntry> | { readonly kind: 'history-entry-not-found'; readonly versionSeq: number };
export type CardHistoryDiffResult =
  | { readonly kind: 'found'; readonly from: number; readonly to: number; readonly diff: CardDiffEntry[] }
  | { readonly kind: 'card-not-found' }
  | { readonly kind: 'invalid-pivots'; readonly from: number; readonly to: number }
  | { readonly kind: 'diff-source-not-found'; readonly from: number; readonly to: number; readonly missingVersionSeq: number };

export type { CardEditPatch, NewChildCardInput, RecordProjection, SetStatusTarget };
type TerminalActivationOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;
type TerminalPublication = {
  lifecycle: Extract<CardRecord['lifecycle'], { status: 'done' | 'failed' | 'blocked' }>;
  status_text: string | null;
  status_text_updated_at: string | null;
};

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

function historyEntry(prior: CardRecord, kind: CardHistoryEntry['kind'], fields: string[], summary: string, reason: string,agentName?:AgentName): CardHistoryEntry {
  const provenance = kind === 'update' ? { changed_by_actor: agentName!, changed_by_surface: 'runtime' }
    : kind === 'delete' ? { changed_by_actor: agentName!, changed_by_surface: 'runtime' }
      : { changed_by_actor: 'runtime', changed_by_surface: 'runtime' };
  return cardHistoryEntrySchema.parse({ entry_id: randomUUID(), kind, card_id: prior.id, version_seq: prior.version_seq, snapshot: prior, changed_at: new Date().toISOString(), ...provenance, change_reason: reason, changed_fields: fields, change_summary: summary });
}

function assertChildParentAdmission(parent: CardRecord, message: string, workflows:CompiledProjectWorkflows): void {
  if ((workflows.cardTypes.get(parent.type)?.permittedChildTypes.size??0)===0 || !canCreateChildInStatus(parent.lifecycle.status)) throw new Error(`${message} '${parent.id}'.`);
}

export class CardService {
  readonly maxDepth = 5;

  constructor(readonly projectRoot: string, readonly workflows: CompiledProjectWorkflows, private readonly freshness: Pick<FreshnessEffects, 'cardProjectionChanged' | 'runtimeChanged'> = NO_FRESHNESS_EFFECTS, private readonly cardAppendIo?: GrowingFileIo) {}

  private recordDefinition(cardId:string,filename:string):RecordDefinition {
    const card = this.read(cardId);
    if (!card) throw new AuthoredRecordNotFoundError();
    const definition = this.workflows.cardTypes.get(card.type)?.records.get(filename as never);
    if (!definition) throw new AuthoredRecordDefinitionNotFoundError();
    return { filename: definition.name, writers: definition.writers, format: definition.format, schema: definition.schema, bootstrap: definition.bootstrap };
  }
  private recordDefinitions(cardId:string):RecordDefinition[]{const card=this.read(cardId);if(!card)throw new Error(`Card '${cardId}' not found.`);const workflow=this.workflows.cardTypes.get(card.type);if(!workflow)throw new Error(`No workflow for '${card.type}'.`);return [...workflow.records.values()].map((definition)=>({filename:definition.name,writers:definition.writers,format:definition.format,schema:definition.schema,bootstrap:definition.bootstrap}));}

  get recordReader() { return { record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => this.readRecord(cardId, filename, version),definition:(cardId:string,filename:string)=>this.recordDefinition(cardId,filename),definitions:(cardId:string)=>this.recordDefinitions(cardId), cardArtifacts: (cardId: string) => readCardArtifacts(this.projectRoot, cardId) }; }

  private state(): CardIndex {
    const state = new CardIndex();
    for (const card of listCards(this.projectRoot).sort((left, right) => cardDepth(left.id) - cardDepth(right.id))) state.upsert(card);
    return state;
  }

  private publishCardVersionEffects(history: CardHistoryEntry, parentId: string | null, runtimeChanged: boolean, recordNames: readonly LiveSyncCardRecordName[] = []): void {
    const cardId = history.card_id;
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'detail', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'history', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'diff', card_id: cardId });
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: cardId });
    if (parentId) this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'children', card_id: parentId });
    for (const record_name of recordNames) this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, record_name });
    if (runtimeChanged) this.freshness.runtimeChanged();
  }

  readActivationAdmission(cardId: string): CardActivationAdmissionProjection | null {
    const child = this.read(cardId);
    if (!child) return null;
    const dependencies = child.depends_on.map((id) => {
      const dependency = this.read(id);
      if (!dependency) throw new CardServiceInvariantError(`Card '${child.id}' depends_on missing card '${id}'.`);
      return { id, status: dependency.lifecycle.status };
    });
    return clone({ child, dependencies });
  }

  read(id: string): CardRecord | null { const card = readCard(this.projectRoot, id); return card ? clone(card) : null; }
  list(): CardRecord[] { return clone(this.state().list()); }
  listChildren(parentId: string): string[] { return readLinkedChildren(this.projectRoot, parentId).map((card) => card.id); }
  getParent(id: string): string | null { return this.state().get(id) ? cardParentId(id) : null; }
  getAncestors(id: string): string[] { const state = this.state(); if (!state.get(id)) return []; const out: string[] = []; let parent = cardParentId(id); while (parent) { if (!state.get(parent)) throw new CardServiceInvariantError(`Card '${id}' has missing linked ancestor '${parent}'.`); out.unshift(parent); parent = cardParentId(parent); } return out; }
  isDescendantOf(id: string, ancestorId: string): boolean { return this.getAncestors(id).includes(ancestorId); }
  getDescendantIds(id: string): string[] { const state = this.state(); const out: string[] = []; const visit = (parent: string): void => { for (const child of state.childrenOf(parent)) { out.push(child); visit(child); } }; visit(id); return out; }
  blocksFor(id: string): string[] { return this.list().filter((card) => card.depends_on.includes(id)).map((card) => card.id); }

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest', instrumentation?: CanonicalReadInstrumentation): RecordProjection { return readAuthoredRecord(this.projectRoot, cardId, this.recordDefinition(cardId,filename), version, instrumentation); }
  openRecord(cardId: string, filename: string): RecordProjection { return openAuthoredRecord(this.projectRoot, cardId, this.recordDefinition(cardId,filename), undefined, this.cardAppendIo); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return replaceOpenAuthoredRecord(this.projectRoot, cardId, this.recordDefinition(cardId,filename), version, content, this.cardAppendIo); }
  closeRecord(cardId: string, filename: string, version: number, agentName: AgentName, cardVersionSeq: number): RecordProjection {
    const closed = closeAuthoredRecord(this.projectRoot, cardId, this.recordDefinition(cardId,filename), version, agentName, cardVersionSeq, this.cardAppendIo);
    this.freshness.cardProjectionChanged({ resource: 'cards', scope: 'record', card_id: cardId, record_name: filename as never });
    return closed;
  }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return discardAuthoredRecord(this.projectRoot, cardId, this.recordDefinition(cardId,filename), version, reason, this.cardAppendIo); }

  getCardDetail(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CardRecord> {
    return clone(readCardDetail(this.projectRoot, id, instrumentation));
  }
  getCanonicalCard(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalCardProjection> {
    return readCanonicalCard(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardChildren(id: string, instrumentation?: CanonicalReadInstrumentation): CardTargetRead<CanonicalLinkedChildrenProjection> {
    return readCanonicalCardHierarchy(this.projectRoot, id, instrumentation);
  }
  getCanonicalCardFilesMetadata(id: string): CardTargetRead<CanonicalCardFilesMetadataProjection> {
    if(!this.read(id))return {kind:'card-not-found'};
    return readCanonicalCardFilesMetadata(this.projectRoot, id,this.recordDefinitions(id));
  }
  getCanonicalCardFileContent(id: string, slot: CanonicalCardFileSlot, maximumBytes: number): CanonicalCardFileContentRead {
    if(!this.read(id))return {kind:'card-not-found'};
    return readCanonicalCardFileContent(this.projectRoot, id, slot, maximumBytes,this.recordDefinitions(id));
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

  create(input: NewChildCardInput): CardRecord {
    if(input.bootstrap_content.trim().length===0)throw new Error('Child bootstrap_content must contain non-whitespace Markdown.');
    if(input.title.length===0||!Number.isInteger(input.priority))throw new Error('Child title and priority are invalid.');
    const parent = this.read(input.parent);
    if (!parent) throw new Error(`Parent card '${input.parent}' does not exist.`);
    assertChildParentAdmission(parent, 'Cannot create a child under', this.workflows);
    const depth = cardDepth(parent.id) + 1;
    if (depth > this.maxDepth) throw new Error(`Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}.`);
    for (const dependencyId of input.depends_on) if (!this.read(dependencyId)) throw new Error(`Dependency card '${dependencyId}' does not exist.`);
    const parentBeforeClaim = this.read(parent.id);
    if (!parentBeforeClaim) throw new Error(`Parent '${parent.id}' changed before child namespace claim.`);
    assertChildParentAdmission(parentBeforeClaim, 'Cannot claim a child namespace under', this.workflows);
    const childWorkflow=this.workflows.cardTypes.get(input.type);if(!childWorkflow)throw new Error(`No workflow for child type '${input.type}'.`);
    const card = publishInitialChildCard(this.projectRoot, input,childWorkflow);
    if (cardParentId(card.id) !== parentBeforeClaim.id || cardDepth(card.id) !== depth) throw new Error(`Claimed card '${card.id}' does not belong to requested parent '${parentBeforeClaim.id}'.`);
    const freshParent = this.read(parent.id);
    if (!freshParent || freshParent.children.includes(card.id)) throw new Error(`Parent '${parent.id}' changed during child publication.`);
    assertChildParentAdmission(freshParent, 'Cannot link a child under', this.workflows);
    const linked = cardRecordSchema.parse({ ...freshParent, children: [...freshParent.children, card.id], version_seq: freshParent.version_seq + 1, updated_at: new Date().toISOString() });
    const linkHistory = historyEntry(freshParent, 'child_link', ['children'], `linked child ${card.id}`, 'child linked');
    publishCardVersion(this.projectRoot, linked, linkHistory, this.cardAppendIo);
    this.publishCardVersionEffects(linkHistory, cardParentId(freshParent.id), true);
    return clone(card);
  }

  private publishVersion(existing: CardRecord, candidate: CardRecord, kind: CardHistoryEntry['kind'], fields: string[], reason: string, summary = summarizeChangedFields(fields),agentName?:AgentName): CardRecord {
    const history = historyEntry(existing, kind, fields, summary, reason,agentName);
    publishCardVersion(this.projectRoot, cardRecordSchema.parse(candidate), history, this.cardAppendIo);
    this.publishCardVersionEffects(history, cardParentId(existing.id), fields.includes('lifecycle'));
    return clone(candidate);
  }

  editCard(id: string, changes: CardEditPatch,agentName:AgentName): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    if (!['backlog', 'changed', 'stopped'].includes(existing.lifecycle.status)) throw new Error(`Card '${id}' cannot be edited in status '${existing.lifecycle.status}'.`);
    const patch = pruneCardEditPatch(existing, changes);
    if (Object.keys(patch).length === 0) return existing;
    const candidate = buildEditedCard(existing, patch, new Date().toISOString());
    const fields = collectEditChangedFields(existing, candidate, patch);
    return this.publishVersion(existing, candidate, 'update', fields, 'agent edit_card',undefined,agentName);
  }

  setStatus(id: string, status: SetStatusTarget): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    assertSetStatusAdmission(existing, status);
    const notifications = status === 'cancelled' ? [] : existing.pending_notifications;
    const fields = ['lifecycle', ...(status === 'cancelled' && existing.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
    const candidate = { ...existing, lifecycle: buildSetStatusLifecycle(status), pending_notifications: notifications, updated_at: new Date().toISOString(), version_seq: existing.version_seq + 1 };
    return this.publishVersion(existing, candidate, 'status', fields, `status -> ${status}`);
  }
  stopRunningForRecovery(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.lifecycle.status !== 'running') throw new Error(`Card '${id}' must be running before recovery can stop it.`);
    const candidate = { ...card, lifecycle: buildStoppedLifecycle(), updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 };
    return this.publishVersion(card, candidate, 'status', ['lifecycle'], 'recovery stopped lifecycle');
  }
  activateStopped(id: string): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (card.lifecycle.status !== 'stopped') throw new Error(`Card '${id}' must be stopped before it can be activated through STOPPED.`);
    const candidate = { ...card, lifecycle: buildActivatedStoppedLifecycle(), updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 };
    return this.publishVersion(card, candidate, 'status', ['lifecycle'], 'STOPPED activation');
  }
  enqueueNotification(id: string, notification: CardNotification): CardRecord {
    const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`);
    const next = enqueueCardNotification(card, notification);
    return this.publishVersion(card, { ...next, updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 }, 'notification_enqueue', ['pending_notifications'], 'notification enqueued', 'notification enqueued');
  }
  removeNotifications(id: string, notificationIds: readonly string[]): CardRecord {
    const card = this.read(id); if (!card) throw new Error(`Card '${id}' not found.`);
    const next = removeCardNotifications(card, notificationIds);
    return this.publishVersion(card, { ...next, updated_at: new Date().toISOString(), version_seq: card.version_seq + 1 }, 'notification_remove', ['pending_notifications'], 'notifications delivered', 'notifications delivered');
  }

  commitActivationOutcome(id: string, outcome: TerminalActivationOutcome, settledAt: string): CardRecord {
    const existing = this.read(id); if (!existing) throw new Error(`Card '${id}' not found.`);
    if (existing.lifecycle.status !== 'running') throw new Error(`Card '${id}' must be running before terminal lifecycle commit.`);
    if (outcome.result.summary !== outcome.summary) throw new Error('Activation outcome summary must equal result summary.');
    const terminal: TerminalPublication = (() => {
      switch (outcome.status) {
        case 'done': return { lifecycle: { status: 'done', result: outcome.result, error: null, completed_at: settledAt }, status_text: outcome.summary, status_text_updated_at: settledAt };
        case 'failed': return { lifecycle: { status: 'failed', result: outcome.result, error: outcome.summary, completed_at: settledAt }, status_text: outcome.summary, status_text_updated_at: settledAt };
        case 'blocked': return { lifecycle: { status: 'blocked', result: outcome.result, error: outcome.summary, completed_at: null }, status_text: outcome.summary, status_text_updated_at: settledAt };
      }
    })();
    const fields = ['lifecycle', ...(!valuesEqual(existing.status_text, terminal.status_text) ? ['status_text'] : []), ...(!valuesEqual(existing.status_text_updated_at, terminal.status_text_updated_at) ? ['status_text_updated_at'] : []), ...(existing.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
    const candidate = { ...existing, ...terminal, pending_notifications: [], updated_at: new Date().toISOString(), version_seq: existing.version_seq + 1 };
    return this.publishVersion(existing, candidate, 'terminal', fields, 'terminal lifecycle commit');
  }

  reorderChildren(parentId: string, orderedChildIds: string[]): { ok: true; changed: number } | { ok: false; reason: string; missing: string[]; extra: string[] } {
    const { parent, activeChildren } = readLinkedChildrenProjection(this.projectRoot, parentId);
    const actual = activeChildren.map((card) => card.id);
    const actualSet = new Set(actual);
    const requestedSet = new Set(orderedChildIds);
    if (actual.length !== orderedChildIds.length || requestedSet.size !== orderedChildIds.length || actual.some((id) => !requestedSet.has(id))) {
      return { ok: false, reason: 'ordered child ids do not match current children', missing: actual.filter((id) => !requestedSet.has(id)), extra: orderedChildIds.filter((id) => !actualSet.has(id)) };
    }
    const retained = parent.children.filter((id) => !actualSet.has(id));
    const fullOrder = [...orderedChildIds, ...retained];
    const changed = fullOrder.reduce((count, id, index) => count + (parent.children[index] === id ? 0 : 1), 0);
    if (changed === 0) return { ok: true, changed: 0 };
    this.publishExactChildReorder(parent, fullOrder);
    return { ok: true, changed };
  }

  private publishExactChildReorder(parent: CardRecord, fullOrder: string[]): CardRecord {
    if (new Set(fullOrder).size !== fullOrder.length || fullOrder.length !== parent.children.length || parent.children.some((id) => !fullOrder.includes(id)) || valuesEqual(fullOrder, parent.children)) throw new Error('Exact child reorder requires a nonidentity complete same-membership permutation.');
    return this.publishVersion(parent, { ...parent, children: fullOrder, version_seq: parent.version_seq + 1, updated_at: new Date().toISOString() }, 'reorder', ['children'], 'children reordered', 'children reordered');
  }

  deleteSubtrees(requestedIds: readonly string[], allowed: (card: CardRecord) => boolean,agentName:AgentName): { deleted: string[]; requested: string[] } {
    if (requestedIds.length === 0) throw new Error('Deletion requires at least one card id.');
    const state = this.state(); const roots = [...new Set(requestedIds)]; const intended = new Set<string>();
    for (const id of roots) { const card = state.get(id); if (!card || id === 'project') throw new Error(`Card '${id}' cannot be deleted.`); intended.add(id); for (const child of state.descendantsOf(id)) intended.add(child); }
    for (const id of intended) if (!allowed(state.get(id)!)) throw new Error(`Deletion denied for card '${id}'.`);
    for (const survivor of state.list()) for (const dependency of survivor.depends_on) if (!intended.has(survivor.id) && intended.has(dependency)) throw new Error(`Surviving card '${survivor.id}' depends on deleted card '${dependency}'.`);
    const outgoing = new Map<string, Set<string>>([...intended].map((id) => [id, new Set()])); const indegree = new Map<string, number>([...intended].map((id) => [id, 0]));
    const edge = (from: string, to: string): void => { const set = outgoing.get(from)!; if (!set.has(to)) { set.add(to); indegree.set(to, indegree.get(to)! + 1); } };
    for (const id of intended) { const card = state.get(id)!; const parent = cardParentId(id); if (parent && intended.has(parent)) edge(id, parent); for (const dependency of card.depends_on) if (intended.has(dependency)) edge(id, dependency); }
    const ready = [...intended].filter((id) => indegree.get(id) === 0).sort(); const order: string[] = [];
    while (ready.length) { const id = ready.shift()!; order.push(id); for (const next of outgoing.get(id)!) { indegree.set(next, indegree.get(next)! - 1); if (indegree.get(next) === 0) { ready.push(next); ready.sort(); } } }
    if (order.length !== intended.size) throw new Error('Deletion dependency and hierarchy constraints conflict.');
    for (const id of order) { const card = state.get(id)!;const recordNames=[...this.workflows.cardTypes.get(card.type)!.records.keys()]; const entry = historyEntry(card, 'delete', ['__deleted__'], 'card deleted', 'analyst subtree deletion',agentName); publishCardTombstone(this.projectRoot, id, card, entry, this.cardAppendIo); this.publishCardVersionEffects(entry, cardParentId(card.id), true, recordNames); }
    return { deleted: order, requested: roots };
  }
}

export { CardServiceInvariantError } from './errors.js';
