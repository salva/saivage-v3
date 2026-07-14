import type { CardStore } from '../cards/store-api.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { ConfigMutation, ResolvedConfigAuthority } from '../config/index.js';
import { queueNotification, resolveRecipient } from '../notifications/index.js';
import { decide } from '../permissions/index.js';
import type { CardRecord, CardStatus, CardType, ControlActionSurface } from '../schemas/index.js';
import { propagateAnalystBriefEdit, propagateChange } from '../runtime/changed-propagation.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import { toCardView } from './read-models/card-view.js';
import type { ToolResult } from '../tools/analyst-tool-types.js';
import { resolveRecordWriteTarget } from '../workspace/index.js';

export interface CreateAnalystCardInput {
  type: CardType;
  parent: string | null;
  title: string;
  brief: string;
  status?: CardStatus;
  tags?: string[];
  priority?: number;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  depends_on?: string[];
  related?: string[];
}

export interface AnalystCardMutationService {
  validateCreate(input: CreateAnalystCardInput): { allowed: true } | { allowed: false; reason: string };
  validateDelete(ids: readonly string[]): { allowed: true } | { allowed: false; reason: string };
  validateCancel(cardId: string): { allowed: true } | { allowed: false; reason: string };
  validateReorder(parentId: string, orderedChildIds: readonly string[]): { allowed: true } | { allowed: false; reason: string };
  create(input: CreateAnalystCardInput): ToolResult;
  delete(ids: readonly string[]): ToolResult;
  cancel(cardId: string, reason?: string): ToolResult;
  reorder(parentId: string, orderedChildIds: readonly string[]): ToolResult;
}

export interface AnalystConfigMutationService {
  validate(mutation: ConfigMutation): { allowed: true } | { allowed: false; reason: string };
  apply(mutation: ConfigMutation): ToolResult;
}

export interface AnalystNotificationMutationService {
  validate(recipient: string): { allowed: true } | { allowed: false; reason: string };
  queue(recipient: string, kind: string, body: string): ToolResult;
}

export interface AnalystBriefRecordMutationService {
  validateWrite(path: string, content: string): { allowed: true } | { allowed: false; reason: string };
  validateEdit(path: string, oldString: string, replaceAll: boolean): { allowed: true } | { allowed: false; reason: string };
  write(path: string, content: string): ToolResult;
  edit(path: string, oldString: string, newString: string, replaceAll: boolean): ToolResult;
}

export interface AnalystMutationServices {
  cards: AnalystCardMutationService;
  config: AnalystConfigMutationService;
  notifications: AnalystNotificationMutationService;
  briefRecords: AnalystBriefRecordMutationService;
}

export function createAnalystMutationServices(input: { projectRoot: string; store: CardStore; configAuthority: ResolvedConfigAuthority; surface: ControlActionSurface; notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard'] }): AnalystMutationServices {
  const notifyCard = input.notifyCard ?? (() => ({ ok: true }));
  return {
    cards: new DefaultAnalystCardMutationService(input.store, input.surface, notifyCard),
    config: new DefaultAnalystConfigMutationService(input.configAuthority),
    notifications: new DefaultAnalystNotificationMutationService(input.projectRoot, input.store, input.surface, notifyCard),
    briefRecords: new DefaultAnalystBriefRecordMutationService(input.projectRoot, input.store, notifyCard),
  };
}

function failure(error: string, data?: Record<string, unknown>): ToolResult {
  return { success: false, error, ...(data ? { data } : {}) };
}

function subtree(store: CardStore, rootId: string): CardRecord[] {
  return [rootId, ...store.getDescendantIds(rootId)].map((id) => store.read(id)).filter((card): card is CardRecord => card !== null);
}

export class DefaultAnalystCardMutationService implements AnalystCardMutationService {
  constructor(private readonly store: CardStore, private readonly surface: ControlActionSurface, private readonly notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}

  validateCreate(input: CreateAnalystCardInput): { allowed: true } | { allowed: false; reason: string } {
    if (input.type === 'project' && input.parent === null) return { allowed: false, reason: 'Root project card already exists' };
    if (input.parent === null) return { allowed: false, reason: 'non-project card requires a parent' };
    const parent = this.store.read(input.parent);
    if (!parent) return { allowed: false, reason: `parent '${input.parent}' does not exist` };
    const permission = decide({ role: 'analyst', action: 'card.create', targetState: parent.status });
    if (!permission.allowed) return permission;
    if (input.status !== undefined && input.status !== 'backlog') return { allowed: false, reason: 'Analyst-created cards must start in backlog' };
    return { allowed: true };
  }

  validateDelete(ids: readonly string[]): { allowed: true } | { allowed: false; reason: string } {
    if (ids.length > 1) return { allowed: true };
    for (const id of ids) {
      const card = this.store.read(id);
      if (!card) continue;
      if (card.id === PROJECT_CARD_ID) return { allowed: false, reason: 'root project card cannot be deleted' };
      for (const candidate of subtree(this.store, id)) {
        const permission = decide({ role: 'analyst', action: 'card.delete', targetState: candidate.status });
        if (!permission.allowed) return permission;
      }
    }
    return { allowed: true };
  }

  validateCancel(cardId: string): { allowed: true } | { allowed: false; reason: string } {
    const card = this.store.read(cardId);
    if (!card) return { allowed: false, reason: `card '${cardId}' does not exist` };
    if (card.id === PROJECT_CARD_ID) return { allowed: false, reason: 'root project card cannot be cancelled' };
    for (const candidate of subtree(this.store, cardId)) {
      const permission = decide({ role: 'analyst', action: 'card.cancel', targetState: candidate.status });
      if (!permission.allowed) return permission;
    }
    return { allowed: true };
  }

  validateReorder(parentId: string, orderedChildIds: readonly string[]): { allowed: true } | { allowed: false; reason: string } {
    const parent = this.store.read(parentId);
    if (!parent) return { allowed: false, reason: `parent '${parentId}' does not exist` };
    const permission = decide({ role: 'analyst', action: 'card.reorder_child', targetState: parent.status });
    if (!permission.allowed) return { allowed: false, reason: `parent '${parentId}' is ${parent.status}` };
    const current = this.store.listChildren(parentId);
    if (current.length !== orderedChildIds.length || current.some((id) => !orderedChildIds.includes(id))) return { allowed: false, reason: 'reorder_set_mismatch' };
    for (const id of orderedChildIds) for (const candidate of subtree(this.store, id)) {
      const childPermission = decide({ role: 'analyst', action: 'card.reorder_child', targetState: candidate.status });
      if (!childPermission.allowed) return { allowed: false, reason: `child subtree '${id}' contains '${candidate.id}' in status ${candidate.status}` };
    }
    return { allowed: true };
  }

  create(input: CreateAnalystCardInput): ToolResult {
    const parent = input.parent;
    if (input.type === 'project' && parent === null) return failure('Root project card already exists. Use card-management tools or record writes to update project objectives.', { id: PROJECT_CARD_ID });
    if (parent === null) return failure(`Cannot create ${input.type} card without a parent. Inspect the card tree and provide an existing parent ID.`, { field: 'parent' });
    const parentCard = this.store.read(parent);
    if (!parentCard) return failure(`Parent card '${parent}' does not exist.`, { parent });
    const permission = decide({ role: 'analyst', action: 'card.create', targetState: parentCard.status });
    if (!permission.allowed) return failure(`create_card denied for parent '${parentCard.id}' in status '${parentCard.status}' (${permission.reason}).`, { parent: parentCard.id, status: parentCard.status });
    if (input.status !== undefined && input.status !== 'backlog') return failure('Analyst create_card can only create backlog child cards. Card creation does not dispatch work or set lifecycle state.', { status: input.status });
    const card = this.store.create({ type: input.type, parent, depth: 0, title: input.title, brief: input.brief, status: input.status ?? 'backlog', tags: input.tags ?? [], priority: input.priority ?? 0, urgency: input.urgency ?? 'normal', created_by: 'analyst', depends_on: input.depends_on ?? [], related: input.related ?? [], retries: 0 });
    try { propagateChange(this.store, parent, { kind: 'analyst_edit', summary: `analyst created child card ${card.id}` }, this.notifyCard); } catch { /* notification is best effort */ }
    return { success: true, data: toCardView(this.store, card) };
  }

  delete(ids: readonly string[]): ToolResult {
    const deletedTopLevel: string[] = [];
    const deletedAll: string[] = [];
    const failures: Array<{ id: string; reason: string }> = [];
    for (const targetId of ids) {
      const card = this.store.read(targetId);
      if (!card) { failures.push({ id: targetId, reason: `Card '${targetId}' not found.` }); continue; }
      if (card.id === PROJECT_CARD_ID) { failures.push({ id: targetId, reason: 'delete_card cannot delete the root project card.' }); continue; }
      const cards = subtree(this.store, targetId).sort((a, b) => b.depth - a.depth);
      if (cards.some((candidate) => !decide({ role: 'analyst', action: 'card.delete', targetState: candidate.status }).allowed)) {
        failures.push({ id: targetId, reason: 'delete_card denied by permission matrix' });
        continue;
      }
      this.store.archiveAndDeleteSubtree(cards.map((candidate) => candidate.id));
      deletedAll.push(...cards.map((candidate) => candidate.id));
      if (card.parent) try { propagateChange(this.store, card.parent, { kind: 'analyst_edit', summary: `analyst deleted card subtree ${targetId}` }, this.notifyCard); } catch { /* notification is best effort */ }
      deletedTopLevel.push(targetId);
    }
    if (deletedTopLevel.length > 0 && failures.length > 0) return { success: true, data: { partial: true, total: ids.length, succeeded: deletedTopLevel.length, failures } };
    if (failures.length > 0) return failure(failures.map((entry) => `${entry.id}: ${entry.reason}`).join('; '), { failures });
    return { success: true, data: { deleted: deletedAll, top_level_deleted: deletedTopLevel } };
  }

  cancel(cardId: string, reason?: string): ToolResult {
    const card = this.store.read(cardId);
    if (!card) return failure(`Card '${cardId}' not found.`, { cardId });
    if (card.id === PROJECT_CARD_ID) return failure('cancel_card cannot cancel the root project card.', { cardId });
    const cards = subtree(this.store, cardId);
    const denied = cards.find((candidate) => !decide({ role: 'analyst', action: 'card.cancel', targetState: candidate.status }).allowed);
    if (denied) return failure(`cancel_card denied for '${denied.id}' in status '${denied.status}'.`, { cardId: denied.id, status: denied.status });
    const updated = cards.sort((a, b) => b.depth - a.depth).map((candidate) => this.store.setStatus(candidate.id, 'cancelled'));
    const anchor = card.parent ?? cardId;
    try { propagateChange(this.store, anchor, { kind: 'analyst_edit', summary: reason ? `analyst cancelled card: ${reason}` : 'analyst cancelled card' }, this.notifyCard); } catch { /* notification is best effort */ }
    return { success: true, data: { cancelled: updated.map((candidate) => candidate.id), root: cardId } };
  }

  reorder(parentId: string, orderedChildIds: readonly string[]): ToolResult {
    const parent = this.store.read(parentId);
    if (!parent) return failure(`Parent card '${parentId}' not found.`, { parentId });
    const permission = decide({ role: 'analyst', action: 'card.reorder_child', targetState: parent.status });
    if (!permission.allowed) return failure(`reorder_child denied for parent '${parent.id}' in status '${parent.status}' (${permission.reason}).`, { parentId, status: parent.status });
    for (const childId of orderedChildIds) {
      const child = this.store.read(childId);
      if (!child) continue;
      const blocked = subtree(this.store, child.id).find((candidate) => !decide({ role: 'analyst', action: 'card.reorder_child', targetState: candidate.status }).allowed);
      if (blocked) return failure(`reorder_child denied for child subtree '${child.id}' because '${blocked.id}' is in status '${blocked.status}'.`, { childId, blockedCardId: blocked.id, status: blocked.status });
    }
    const result = this.store.reorderChildren(parentId, [...orderedChildIds], { actor: 'analyst', surface: this.surface, reason: 'analyst reorder_child' });
    if (!result.ok) return failure('reorder_set_mismatch', { reason: 'reorder_set_mismatch', missing: result.missing, extra: result.extra, parent_id: parentId });
    try { propagateChange(this.store, parentId, { kind: 'analyst_edit', summary: `analyst reordered children of ${parentId}` }, this.notifyCard); } catch { /* notification is best effort */ }
    return { success: true, data: { parent_id: parentId, changed: result.changed } };
  }
}

export class DefaultAnalystConfigMutationService implements AnalystConfigMutationService {
  constructor(private readonly authority: ResolvedConfigAuthority) {}
  validate(mutation: ConfigMutation): { allowed: true } | { allowed: false; reason: string } {
    const result = this.authority.validateChange(mutation);
    return result.success ? { allowed: true } : { allowed: false, reason: result.message };
  }
  apply(mutation: ConfigMutation): ToolResult {
    const result = this.authority.applyChange(mutation);
    if (!result.success) return failure(result.message, { reason: 'invalid_argument', fieldPath: result.fieldPath, detail: result.message });
    if (mutation.kind === 'set_server_setting' && result.requires_restart) return { success: true, data: { applied: true, requires_restart: true, key: mutation.key } };
    return { success: true, data: { applied: true, action: mutation.kind } };
  }
}

export class DefaultAnalystNotificationMutationService implements AnalystNotificationMutationService {
  constructor(private readonly projectRoot: string, private readonly store: CardStore, private readonly surface: ControlActionSurface, private readonly notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}
  validate(recipient: string): { allowed: true } | { allowed: false; reason: string } {
    return resolveRecipient(this.projectRoot, this.store, recipient) === null ? { allowed: false, reason: `unknown recipient '${recipient}'` } : { allowed: true };
  }
  queue(recipient: string, kind: string, body: string): ToolResult {
    const resolved = resolveRecipient(this.projectRoot, this.store, recipient);
    if (resolved === null) return failure(`Unknown notification recipient '${recipient}'.`, { reason: 'unknown_recipient', recipient });
    const queued = queueNotification(this.projectRoot, resolved, kind, body, { actor: 'analyst', surface: this.surface }, this.store, this.notifyCard);
    if (!queued.ok) {
      const missingCards = queued.cardDeliveries.filter((delivery) => !delivery.result.ok && delivery.result.reason === 'missing_card').map((delivery) => delivery.cardId);
      return failure(`Notification delivery failed for missing card(s): ${missingCards.join(', ')}.`, { reason: 'missing_card', recipient, cardIds: missingCards, notificationId: queued.notificationId });
    }
    return { success: true, data: { queued: true, recipient } };
  }
}

export class DefaultAnalystBriefRecordMutationService implements AnalystBriefRecordMutationService {
  constructor(private readonly projectRoot: string, private readonly store: CardStore, private readonly notifyCard: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}

  validateWrite(path: string, content: string): { allowed: true } | { allowed: false; reason: string } {
    try { this.resolve(path, content); return { allowed: true }; } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error) }; }
  }

  validateEdit(path: string, oldString: string, replaceAll: boolean): { allowed: true } | { allowed: false; reason: string } {
    try {
      const target = this.resolve(path);
      const content = this.store.readRecord(target.cardId, 'brief.md', 'latest').artifact.content;
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) throw new Error('old_string was not found.');
      if (occurrences > 1 && !replaceAll) throw new Error('old_string appears multiple times; set replace_all to true.');
      return { allowed: true };
    } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error) }; }
  }

  write(path: string, content: string): ToolResult {
    const target = this.resolve(path, content);
    return this.commit(target.cardId, content);
  }

  edit(path: string, oldString: string, newString: string, replaceAll: boolean): ToolResult {
    const target = this.resolve(path);
    const content = this.store.readRecord(target.cardId, 'brief.md', 'latest').artifact.content;
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    this.resolve(path, next);
    return this.commit(target.cardId, next);
  }

  private resolve(path: string, content?: string): { cardId: string; recordUrl: string } {
    const target = resolveRecordWriteTarget({ projectRoot: this.projectRoot, records: this.store.recordReader, agent: { agentRole: 'analyst' }, fail: (message) => { throw new Error(message); } }, path);
    if (target.filename !== 'brief.md') throw new Error('Analyst write only supports record:///brief.md document writes.');
    if (target.version !== 'next') throw new Error('Analyst record writes must use v=next.');
    if (content !== undefined) {
      if (content.length === 0) throw new Error('brief.md content must not be empty.');
      for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) if (!content.includes(heading)) throw new Error(`brief.md must include '${heading}'.`);
    }
    const card = this.store.read(target.cardId);
    if (!card) throw new Error(`Card '${target.cardId}' not found.`);
    if (!['backlog', 'done', 'failed', 'running'].includes(card.status)) throw new Error(`Analyst brief edits require target card status backlog, done, failed, or running. Current status is ${card.status}.`);
    try { this.store.readRecord(target.cardId, 'brief.md', 'open'); throw new Error(`Cannot write '${target.recordUrl}': latest brief.md version is open.`); } catch (error) { if (error instanceof Error && error.message.startsWith('Cannot write')) throw error; }
    return { cardId: target.cardId, recordUrl: target.recordUrl };
  }

  private commit(cardId: string, content: string): ToolResult {
    const card = this.store.read(cardId)!;
    const open = this.store.openRecord(cardId, 'brief.md');
    this.store.editRecord(cardId, 'brief.md', open.version, content);
    const closed = this.store.closeRecord(cardId, 'brief.md', open.version, 'analyst', card.version_seq);
    try {
      propagateAnalystBriefEdit(this.store, cardId, { kind: 'analyst_edit', summary: 'Analyst updated brief.md' }, this.notifyCard);
      return { success: true, data: { card_id: cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(content), written: true, propagation: { ok: true } } };
    } catch (error) {
      return { success: true, data: { card_id: cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(content), written: true, propagation: { ok: false, partial: true, error: error instanceof Error ? error.message : String(error) } } };
    }
  }
}
