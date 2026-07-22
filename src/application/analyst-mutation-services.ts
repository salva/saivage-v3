import type { CardService } from '../cards/card-api.js';
import { AuthoredRecordNotFoundError, PROJECT_CARD_ID } from '../cards/card-api.js';
import { analystBriefEditEffect, canCancelCardStatus, canCreateChildInStatus } from '../cards/status-api.js';
import type { ConfigMutation, ResolvedConfigAuthority } from '../config/index.js';
import { queueNotification } from '../notifications/index.js';
import type { CardRecord, CardType } from '../schemas/index.js';
import { propagateAnalystBriefEdit, propagateChange } from '../runtime/changed-propagation.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import { toCardView } from './read-models/card-view.js';
import { resolveRecordWriteTarget } from '../workspace/index.js';

export type AnalystMutationOutcome =
  | { kind: 'denied'; reason: string }
  | { kind: 'returned'; success: true; data?: unknown }
  | { kind: 'returned'; success: false; error: string; data?: unknown };

export interface CreateAnalystCardInput {
  type: CardType;
  parent: string | null;
  title: string;
  brief: string;
  tags?: string[];
  priority?: number;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  depends_on?: string[];
  related?: string[];
}

export interface AnalystCardMutationService {
  create(input: CreateAnalystCardInput): AnalystMutationOutcome;
  delete(ids: readonly string[]): AnalystMutationOutcome;
  cancel(cardId: string, reason?: string): Promise<AnalystMutationOutcome>;
  reorder(parentId: string, orderedChildIds: readonly string[]): AnalystMutationOutcome;
}

export interface AnalystConfigMutationService {
  apply(mutation: ConfigMutation): AnalystMutationOutcome;
}

export interface AnalystNotificationMutationService {
  queue(cardId: string, kind: string, body: string): AnalystMutationOutcome;
}

export interface AnalystBriefRecordMutationService {
  write(path: string, content: string): AnalystMutationOutcome;
  edit(path: string, oldString: string, newString: string, replaceAll: boolean): AnalystMutationOutcome;
}

export interface AnalystMutationServices {
  cards: AnalystCardMutationService;
  config: AnalystConfigMutationService;
  notifications: AnalystNotificationMutationService;
  briefRecords: AnalystBriefRecordMutationService;
}

export function createAnalystMutationServices(input: { projectRoot: string; store: CardService; configAuthority: ResolvedConfigAuthority; notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard']; cancelCard: Pick<RuntimeApi, 'cancelCard'>['cancelCard'] }): AnalystMutationServices {
  const notifyCard = input.notifyCard ?? ((_cardId, notification) => ({ ok: true, notificationId: notification.id }));
  return {
    cards: new AnalystCardMutationImplementation(input.store, notifyCard, input.cancelCard),
    config: new AnalystConfigMutationImplementation(input.configAuthority),
    notifications: new AnalystNotificationMutationImplementation(input.projectRoot, input.store, notifyCard),
    briefRecords: new AnalystBriefRecordMutationImplementation(input.projectRoot, input.store, notifyCard),
  };
}

function failure(error: string, data?: Record<string, unknown>): AnalystMutationOutcome {
  return { kind: 'returned', success: false, error, ...(data ? { data } : {}) };
}

function success(data?: unknown): AnalystMutationOutcome {
  return { kind: 'returned', success: true, ...(data === undefined ? {} : { data }) };
}

function denied(reason: string): AnalystMutationOutcome { return { kind: 'denied', reason }; }

class AnalystMutationDeniedError extends Error {}

function denialFrom(error: unknown): AnalystMutationOutcome {
  if (error instanceof AnalystMutationDeniedError) return denied(error.message);
  throw error;
}

function subtree(store: CardService, rootId: string): CardRecord[] {
  return [rootId, ...store.getDescendantIds(rootId)].map((id) => store.read(id)).filter((card): card is CardRecord => card !== null);
}

class AnalystCardMutationImplementation implements AnalystCardMutationService {
  constructor(private readonly store: CardService, private readonly notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard'], private readonly cancelCardPort?: Pick<RuntimeApi, 'cancelCard'>['cancelCard']) {}

  create(input: CreateAnalystCardInput): AnalystMutationOutcome {
    const parent = input.parent;
    if (input.type === 'project' && parent === null) return denied('Root project card already exists');
    if (parent === null) return denied('non-project card requires a parent');
    const parentCard = this.store.read(parent);
    if (!parentCard) return denied(`parent '${parent}' does not exist`);
    if (!canCreateChildInStatus(parentCard.lifecycle.status) || parentCard.lifecycle.status === 'running') return denied('wrong_state');
    if (input.type === 'project') return denied('Root project card already exists');
    const card = this.store.create({ type: input.type, parent, title: input.title, brief: input.brief, tags: input.tags ?? [], priority: input.priority ?? 0, urgency: input.urgency ?? 'normal', created_by: 'analyst', depends_on: input.depends_on ?? [], related: input.related ?? [] });
    try { propagateChange(this.store, parent, { kind: 'analyst_edit', summary: `analyst created child card ${card.id}` }, this.notifyCard); } catch { /* notification is best effort */ }
    return success(toCardView(this.store, card));
  }

  delete(ids: readonly string[]): AnalystMutationOutcome {
    const result = this.store.deleteSubtrees(ids, (card) => card.lifecycle.status !== 'running');
    return success({ deleted: result.deleted, top_level_deleted: result.requested });
  }

  async cancel(cardId: string, reason?: string): Promise<AnalystMutationOutcome> {
    const card = this.store.read(cardId);
    if (!card) return denied(`card '${cardId}' does not exist`);
    if (card.id === PROJECT_CARD_ID) return denied('root project card cannot be cancelled');
    const blocked = subtree(this.store, cardId).find((candidate) => !canCancelCardStatus(candidate.lifecycle.status));
    if (blocked) return denied(`card '${blocked.id}' is ${blocked.lifecycle.status}`);
    if (!this.cancelCardPort) throw new Error('Analyst cancellation requires the runtime cancellation application port.');
    const result = await this.cancelCardPort(cardId, reason ?? 'analyst_cancel_card');
    const anchor = this.store.getParent(card.id) ?? cardId;
    try { propagateChange(this.store, anchor, { kind: 'analyst_edit', summary: reason ? `analyst cancelled card: ${reason}` : 'analyst cancelled card' }, this.notifyCard); } catch { /* notification is best effort */ }
    return success(result);
  }

  reorder(parentId: string, orderedChildIds: readonly string[]): AnalystMutationOutcome {
    const parent = this.store.read(parentId);
    if (!parent) return denied(`parent '${parentId}' does not exist`);
    if (parent.lifecycle.status === 'running') return denied(`parent '${parentId}' is ${parent.lifecycle.status}`);
    const current = this.store.listChildren(parentId);
    if (current.length !== orderedChildIds.length || current.some((id) => !orderedChildIds.includes(id))) return denied('reorder_set_mismatch');
    for (const childId of orderedChildIds) {
      const child = this.store.read(childId);
      if (!child) continue;
      const blocked = subtree(this.store, child.id).find((candidate) => candidate.lifecycle.status === 'running');
      if (blocked) return denied(`child subtree '${child.id}' contains '${blocked.id}' in status ${blocked.lifecycle.status}`);
    }
    const result = this.store.reorderChildren(parentId, [...orderedChildIds]);
    if (!result.ok) return failure('reorder_set_mismatch', { reason: 'reorder_set_mismatch', missing: result.missing, extra: result.extra, parent_id: parentId });
    if (result.changed > 0) {
      try { propagateChange(this.store, parentId, { kind: 'analyst_edit', summary: `analyst reordered children of ${parentId}` }, this.notifyCard); } catch { /* notification is best effort */ }
    }
    return success({ parent_id: parentId, changed: result.changed });
  }
}

class AnalystConfigMutationImplementation implements AnalystConfigMutationService {
  constructor(private readonly authority: ResolvedConfigAuthority) {}
  apply(mutation: ConfigMutation): AnalystMutationOutcome {
    const result = this.authority.applyChange(mutation);
    if (!result.success) return denied(result.message);
    if (mutation.kind === 'set_server_setting' && result.requires_restart) return success({ applied: true, requires_restart: true, key: mutation.key });
    return success({ applied: true, action: mutation.kind });
  }
}

class AnalystNotificationMutationImplementation implements AnalystNotificationMutationService {
  constructor(private readonly projectRoot: string, private readonly store: CardService, private readonly notifyCard?: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}
  queue(cardId: string, kind: string, body: string): AnalystMutationOutcome {
    if (!this.notifyCard) throw new Error('Analyst queue_notification requires the runtime card notification port.');
    const queued = queueNotification(cardId, kind, body, { actor: 'analyst', surface: 'web-chat' }, this.notifyCard);
    if (!queued.ok && queued.reason === 'terminal_card') return failure(`Cannot queue notification for terminal card '${queued.cardId}' in status '${queued.status}'.`, { queued: false, reason: queued.reason, card_id: queued.cardId, status: queued.status });
    if (!queued.ok) return failure(`Card '${queued.cardId}' not found.`, { queued: false, reason: queued.reason, card_id: queued.cardId });
    return success({ queued: true, card_id: cardId, notification_id: queued.notificationId });
  }
}

class AnalystBriefRecordMutationImplementation implements AnalystBriefRecordMutationService {
  constructor(private readonly projectRoot: string, private readonly store: CardService, private readonly notifyCard: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}

  write(path: string, content: string): AnalystMutationOutcome {
    let target;
    try { target = this.resolve(path); this.validateBriefContent(content); }
    catch (error) { return denialFrom(error); }
    const open = this.store.openRecord(target.cardId, 'brief.md');
    this.store.editRecord(target.cardId, 'brief.md', open.version, content);
    const closed = this.store.closeRecord(target.cardId, 'brief.md', open.version, 'analyst', target.card.version_seq);
    try {
      propagateAnalystBriefEdit(this.store, target.cardId, { kind: 'analyst_edit', summary: 'Analyst updated brief.md' }, this.notifyCard);
      return success({ card_id: target.cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(content), written: true, propagation: { ok: true } });
    } catch (error) {
      return success({ card_id: target.cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(content), written: true, propagation: { ok: false, partial: true, error: error instanceof Error ? error.message : String(error) } });
    }
  }

  edit(path: string, oldString: string, newString: string, replaceAll: boolean): AnalystMutationOutcome {
    let target;
    try { target = this.resolve(path); }
    catch (error) { return denialFrom(error); }
    const content = this.store.readRecord(target.cardId, 'brief.md', 'latest').artifact.content;
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) return denied('old_string was not found.');
    if (occurrences > 1 && !replaceAll) return denied('old_string appears multiple times; set replace_all to true.');
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    try { this.validateBriefContent(next); }
    catch (error) { return denialFrom(error); }
    const open = this.store.openRecord(target.cardId, 'brief.md');
    this.store.editRecord(target.cardId, 'brief.md', open.version, next);
    const closed = this.store.closeRecord(target.cardId, 'brief.md', open.version, 'analyst', target.card.version_seq);
    try {
      propagateAnalystBriefEdit(this.store, target.cardId, { kind: 'analyst_edit', summary: 'Analyst updated brief.md' }, this.notifyCard);
      return success({ card_id: target.cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(next), written: true, propagation: { ok: true } });
    } catch (error) {
      return success({ card_id: target.cardId, path: closed.recordUrl, record_url: closed.recordUrl, bytes: Buffer.byteLength(next), written: true, propagation: { ok: false, partial: true, error: error instanceof Error ? error.message : String(error) } });
    }
  }

  private resolve(path: string): { cardId: string; recordUrl: string; card: CardRecord } {
    const target = resolveRecordWriteTarget({ projectRoot: this.projectRoot, records: this.store.recordReader, agent: { agentRole: 'analyst' }, fail: (message) => { throw new AnalystMutationDeniedError(message); } }, path);
    if (target.filename !== 'brief.md') throw new AnalystMutationDeniedError('Analyst write only supports record:///brief.md document writes.');
    if (target.version !== 'next') throw new AnalystMutationDeniedError('Analyst record writes must use v=next.');
    const card = this.store.read(target.cardId);
    if (!card) throw new AnalystMutationDeniedError(`Card '${target.cardId}' not found.`);
    if (analystBriefEditEffect(card.lifecycle.status) === null) throw new AnalystMutationDeniedError(`Analyst brief edits do not support target card status ${card.lifecycle.status}.`);
    try {
      this.store.readRecord(target.cardId, 'brief.md', 'open');
      throw new AnalystMutationDeniedError(`Cannot write '${target.recordUrl}': latest brief.md version is open.`);
    } catch (error) {
      if (error instanceof AnalystMutationDeniedError) throw error;
      if (!(error instanceof AuthoredRecordNotFoundError)) throw error;
    }
    return { cardId: target.cardId, recordUrl: target.recordUrl, card };
  }

  private validateBriefContent(content: string): void {
    if (content.length === 0) throw new AnalystMutationDeniedError('brief.md content must not be empty.');
    for (const heading of ['# Goal', '# Instructions', '# Acceptance Criteria']) if (!content.includes(heading)) throw new AnalystMutationDeniedError(`brief.md must include '${heading}'.`);
  }
}
