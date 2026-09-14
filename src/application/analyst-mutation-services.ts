import type { CardService } from '../cards/card-api.js';
import { PROJECT_CARD_ID } from '../cards/card-api.js';
import { canCancelCardStatus, canCreateChildInStatus } from '../cards/status-api.js';
import type { ConfigMutation, ResolvedConfigAuthority } from '../config/index.js';
import { queueNotification } from '../notifications/index.js';
import type { CardRecord, CardTypeName } from '../schemas/index.js';
import type { NotificationUrgency } from '../contracts/builtin-tool-inputs.js';
import { propagateAnalystRecordEdit, propagateChange } from '../runtime/changed-propagation.js';
import type { RuntimeApi } from '../runtime/runtime-api.js';
import { toCardView } from './read-models/card-view.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import type { AnalystPreNetworkAdmission } from '../contracts/record-mutation.js';
import { mutateRecord, preflightAnalystRecordWrite } from './record-mutation-service.js';
import type { CardId } from '../schemas/card-id.js';

export type AnalystMutationOutcome =
  | { kind: 'denied'; reason: string }
  | { kind: 'returned'; success: true; data?: unknown }
  | { kind: 'returned'; success: false; error: string; data?: unknown };

export interface CreateAnalystCardInput {
  type: CardTypeName;
  parent: CardId;
  title: string;
  bootstrap_content: string;
  tags?: string[];
  priority?: number;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  depends_on?: string[];
  related?: string[];
}

interface AnalystCardMutationService {
  create(input: CreateAnalystCardInput): AnalystMutationOutcome;
  delete(ids: readonly string[]): AnalystMutationOutcome;
  cancel(cardId: string, reason?: string): Promise<AnalystMutationOutcome>;
  reorder(parentId: string, orderedChildIds: readonly string[]): AnalystMutationOutcome;
  reopen(cardId: string): AnalystMutationOutcome;
}

interface AnalystConfigMutationService {
  apply(mutation: ConfigMutation): AnalystMutationOutcome;
}

interface AnalystNotificationMutationService {
  queue(cardId: string, kind: string, body: string, urgency: NotificationUrgency, signal?: AbortSignal): Promise<AnalystMutationOutcome>;
}

export interface AnalystRecordMutationService {
  admitWrite(path: string): AnalystPreNetworkAdmission;
  write(path: string, content: string, requiredTools?: readonly ('write' | 'webfetch')[]): AnalystMutationOutcome;
  edit(path: string, oldString: string, newString: string, replaceAll: boolean): AnalystMutationOutcome;
}

export interface AnalystMutationServices {
  cards: AnalystCardMutationService;
  config: AnalystConfigMutationService;
  notifications: AnalystNotificationMutationService;
  recordMutations: AnalystRecordMutationService;
}

export function createAnalystMutationServices(input: { store: CardService; configAuthority: ResolvedConfigAuthority; notifyCard: Pick<RuntimeApi, 'notifyCard'>['notifyCard']; submitNotification: Pick<RuntimeApi, 'submitNotification'>['submitNotification']; cancelCard: Pick<RuntimeApi, 'cancelCard'>['cancelCard'] }): AnalystMutationServices {
  const notifyCard = input.notifyCard;
  return {
    cards: new AnalystCardMutationImplementation(input.store, notifyCard, input.cancelCard),
    config: new AnalystConfigMutationImplementation(input.configAuthority),
    notifications: new AnalystNotificationMutationImplementation(input.submitNotification),
    recordMutations: new AnalystRecordMutationImplementation(input.store, notifyCard),
  };
}

function failure(error: string, data?: Record<string, unknown>): AnalystMutationOutcome {
  return { kind: 'returned', success: false, error, ...(data ? { data } : {}) };
}

function success(data?: unknown): AnalystMutationOutcome {
  return { kind: 'returned', success: true, ...(data === undefined ? {} : { data }) };
}

function denied(reason: string): AnalystMutationOutcome { return { kind: 'denied', reason }; }

function subtree(store: CardService, rootId: string): CardRecord[] {
  return [rootId, ...store.getDescendantIds(rootId)].map((id) => store.read(id)).filter((card): card is CardRecord => card !== null);
}

class AnalystCardMutationImplementation implements AnalystCardMutationService {
  constructor(private readonly store: CardService, private readonly notifyCard: Pick<RuntimeApi, 'notifyCard'>['notifyCard'], private readonly cancelCardPort: Pick<RuntimeApi, 'cancelCard'>['cancelCard']) {}

  create(input: CreateAnalystCardInput): AnalystMutationOutcome {
    const parent = input.parent;
    const parentCard = this.store.read(parent);
    if (!parentCard) return denied(`parent '${parent}' does not exist`);
    if (!canCreateChildInStatus(parentCard.lifecycle.status) || parentCard.lifecycle.status === 'running') return denied('wrong_state');
    if (input.type === 'project') return denied('Root project card already exists');
    const analyst=this.store.workflows.analyst;
    if(!analyst.canCreateChildren||!analyst.tools.some((tool)=>tool.name==='create_card'))return denied(`agent '${analyst.name}' is not configured to create children`);
    const parentWorkflow=this.store.workflows.cardTypes.get(parentCard.type);if(!parentWorkflow)throw new Error(`No compiled workflow exists for card type '${parentCard.type}'.`);if(!parentWorkflow.permittedChildTypes.has(input.type))return denied(`child type '${input.type}' is not permitted under '${parentCard.type}'`);
    const card = this.store.create({ type: input.type, parent, title: input.title, bootstrap_content: input.bootstrap_content, tags: input.tags ?? [], priority: input.priority ?? 0, urgency: input.urgency ?? 'normal', created_by: this.store.workflows.analyst.name as never, depends_on: input.depends_on ?? [], related: input.related ?? [] });
    try { propagateChange(this.store, parent, { kind: 'analyst_edit', summary: `analyst created child card ${card.id}` }, this.notifyCard); } catch (error) { throwIfPublicationOutcomeUnknown(error); /* notification is best effort */ }
    return success(toCardView(this.store, card));
  }

  delete(ids: readonly string[]): AnalystMutationOutcome {
    const result = this.store.deleteSubtrees(ids, (card) => card.lifecycle.status !== 'running',this.store.workflows.analyst.name);
    return success({ deleted: result.deleted, top_level_deleted: result.requested });
  }

  async cancel(cardId: string, reason?: string): Promise<AnalystMutationOutcome> {
    const card = this.store.read(cardId);
    if (!card) return denied(`card '${cardId}' does not exist`);
    if (card.id === PROJECT_CARD_ID) return denied('root project card cannot be cancelled');
    const blocked = subtree(this.store, cardId).find((candidate) => !canCancelCardStatus(candidate.lifecycle.status));
    if (blocked) return denied(`card '${blocked.id}' is ${blocked.lifecycle.status}`);
    const result = await this.cancelCardPort(cardId, reason ?? 'analyst_cancel_card');
    const anchor = this.store.getParent(card.id) ?? cardId;
    try { propagateChange(this.store, anchor, { kind: 'analyst_edit', summary: reason ? `analyst cancelled card: ${reason}` : 'analyst cancelled card' }, this.notifyCard); } catch (error) { throwIfPublicationOutcomeUnknown(error); /* notification is best effort */ }
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
      try { propagateChange(this.store, parentId, { kind: 'analyst_edit', summary: `analyst reordered children of ${parentId}` }, this.notifyCard); } catch (error) { throwIfPublicationOutcomeUnknown(error); /* notification is best effort */ }
    }
    return success({ parent_id: parentId, changed: result.changed });
  }

  reopen(cardId: string): AnalystMutationOutcome {
    const card = this.store.read(cardId);
    if (!card) return denied(`card '${cardId}' does not exist`);
    if (card.lifecycle.status !== 'done' && card.lifecycle.status !== 'failed' && card.lifecycle.status !== 'blocked') return denied(`card '${cardId}' is ${card.lifecycle.status}`);
    const notifyCard = (targetCardId: string, notification: Parameters<typeof this.notifyCard>[1]): void => {
      try { this.notifyCard(targetCardId, notification); } catch (error) { throwIfPublicationOutcomeUnknown(error); /* notification is best effort */ }
    };
    propagateChange(this.store, cardId, { kind: 'analyst_edit', summary: `analyst reopened card ${cardId}` }, notifyCard);
    const reopened = this.store.read(cardId);
    if (!reopened) throw new Error(`Reopened card '${cardId}' disappeared.`);
    if (reopened.lifecycle.status !== 'changed') throw new Error(`Reopened card '${cardId}' has status '${reopened.lifecycle.status}'.`);
    return success(toCardView(this.store, reopened));
  }
}

class AnalystConfigMutationImplementation implements AnalystConfigMutationService {
  constructor(private readonly authority: ResolvedConfigAuthority) {}
  apply(mutation: ConfigMutation): AnalystMutationOutcome {
    const result = this.authority.applyChange(mutation);
    if (!result.success) return denied(result.message);
    switch(mutation.kind){
      case 'set_agent_model_route':return success({applied:true,requires_restart:true,action:mutation.kind,agent:mutation.agent,model_route:mutation.modelRoute});
      case 'set_model_failover':return success({applied:true,requires_restart:true,action:mutation.kind,for_model:mutation.forModel,ordered_failover_models:[...mutation.orderedFailoverModels]});
      case 'set_server_setting':return success({applied:true,requires_restart:true,action:mutation.kind,key:mutation.key,value:mutation.value});
    }
  }
}

class AnalystNotificationMutationImplementation implements AnalystNotificationMutationService {
  constructor(private readonly submitNotification: Pick<RuntimeApi, 'submitNotification'>['submitNotification']) {}
  async queue(cardId: string, kind: string, body: string, urgency: NotificationUrgency, signal?: AbortSignal): Promise<AnalystMutationOutcome> {
    const queued = await queueNotification(cardId, kind, body, urgency, this.submitNotification, signal);
    if (queued.queued) return success({ queued: true, card_id: queued.cardId, notification_id: queued.notificationId, interruption: queued.interruption });
    switch (queued.reason) {
      case 'missing_card': return failure(`Card '${queued.cardId}' not found.`, { queued: false, reason: queued.reason, card_id: queued.cardId });
      case 'terminal_card': return failure(`Cannot queue notification for terminal card '${queued.cardId}' in status '${queued.status}'.`, { queued: false, reason: queued.reason, card_id: queued.cardId, status: queued.status });
      case 'activation_closed': return failure(`Cannot queue notification for card '${queued.cardId}': its current activation is closed to new notifications.`, { queued: false, reason: queued.reason, card_id: queued.cardId });
      case 'planning_ineligible': return failure(`Card '${queued.cardId}' is not eligible for planning notifications.`, { queued: false, reason: queued.reason, card_id: queued.cardId });
      default: return assertNever(queued);
    }
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled notification result: ${JSON.stringify(value)}`); }

class AnalystRecordMutationImplementation implements AnalystRecordMutationService {
  constructor(private readonly store: CardService, private readonly notifyCard: Pick<RuntimeApi, 'notifyCard'>['notifyCard']) {}

  admitWrite(path: string): AnalystPreNetworkAdmission {
    return preflightAnalystRecordWrite(this.store, { path, operation: 'write', surface: 'analyst', agentName: this.store.workflows.analyst.name, requiredTools: ['write', 'webfetch'] });
  }

  write(path: string, content: string, requiredTools: readonly ('write' | 'webfetch')[] = ['write']): AnalystMutationOutcome {
    const result = mutateRecord(this.store, { path, operation: 'write', content, surface: 'analyst', agentName: this.store.workflows.analyst.name, requiredTools }, () => this.propagate(path));
    return result.kind === 'applied' ? { kind: 'returned', success: true, data: result.data } : { kind: 'returned', success: false, error: result.error, data: result.data };
  }

  edit(path: string, oldString: string, newString: string, replaceAll: boolean): AnalystMutationOutcome {
    const result = mutateRecord(this.store, { path, operation: 'edit', oldString, newString, replaceAll, surface: 'analyst', agentName: this.store.workflows.analyst.name, requiredTools: ['edit'] }, () => this.propagate(path));
    return result.kind === 'applied' ? { kind: 'returned', success: true, data: result.data } : { kind: 'returned', success: false, error: result.error, data: result.data };
  }

  private propagate(path: string): { ok: true } | { ok: false; partial: true; error: string } {
    const parsed = (awaitImportParse(path));
    try {
      propagateAnalystRecordEdit(this.store, parsed.cardId, { kind: 'analyst_edit', summary: `Analyst updated ${parsed.name}` }, this.notifyCard);
      return { ok: true };
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      return { ok: false, partial: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

import { parseRecordUrl as awaitImportParse } from '../contracts/record-mutation.js';
