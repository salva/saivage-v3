import { cardNotificationSchema, type CardNotification, type CardRecord, type CardType, type CreatedBy, type Urgency } from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import { acceptsCardNotifications } from './card-status.js';
import { valuesEqual } from './value-equality.js';

export interface NewChildCardInput {
  type: Exclude<CardType, 'project'>;
  parent: string;
  title: string;
  bootstrap_content: string;
  tags: string[];
  priority: number;
  urgency: Urgency;
  created_by: CreatedBy;
  depends_on: string[];
  related: string[];
}

export type CardEditPatch = Partial<Pick<CardRecord, 'title' | 'tags' | 'priority' | 'urgency' | 'related'>>;
export type SetStatusTarget = 'running' | 'changed' | 'cancelled';
export type SetStatusLifecycle = Extract<CardLifecycleState, { status: SetStatusTarget }>;

const EDIT_FIELDS = ['title', 'tags', 'priority', 'urgency', 'related'] as const satisfies ReadonlyArray<keyof CardEditPatch>;

export function assertSetStatusAdmission(card: CardRecord, target: SetStatusTarget): void {
  const sources: Record<SetStatusTarget, readonly CardRecord['lifecycle']['status'][]> = {
    running: ['backlog', 'blocked', 'changed'],
    changed: ['blocked', 'done', 'failed'],
    cancelled: ['backlog', 'running', 'blocked', 'changed', 'stopped', 'failed'],
  };
  if (!sources[target].includes(card.lifecycle.status)) {
    throw new Error(`Invalid status operation: ${card.lifecycle.status} → ${target}.`);
  }
}

export function buildSetStatusLifecycle(newStatus: SetStatusTarget): SetStatusLifecycle {
  return { status: newStatus, result: null, error: null, completed_at: null };
}

export function buildStoppedLifecycle(): Extract<CardLifecycleState, { status: 'stopped' }> {
  return { status: 'stopped', result: null, error: null, completed_at: null };
}

export function buildActivatedStoppedLifecycle(): Extract<CardLifecycleState, { status: 'running' }> {
  return { status: 'running', result: null, error: null, completed_at: null };
}

export function summarizeChangedFields(changedFields: readonly string[]): string {
  if (changedFields.length === 0) return 'card updated';
  return `${changedFields.join(', ')} updated`;
}

export function pruneCardEditPatch(existing: CardRecord, changes: CardEditPatch): CardEditPatch {
  return Object.fromEntries(EDIT_FIELDS.flatMap((field) => changes[field] !== undefined && !valuesEqual(existing[field], changes[field]) ? [[field, changes[field]]] : [])) as CardEditPatch;
}

export function buildEditedCard(existing: CardRecord, changes: CardEditPatch, stamp: string): CardRecord {
  return { ...existing, ...changes, id: existing.id, created_at: existing.created_at, created_by: existing.created_by, updated_at: stamp, version_seq: existing.version_seq + 1 };
}

export function collectEditChangedFields(existing: CardRecord, candidate: CardRecord, changes: CardEditPatch): string[] {
  return EDIT_FIELDS.filter((field) => changes[field] !== undefined && !valuesEqual(existing[field], candidate[field]));
}

export function enqueueCardNotification(card: CardRecord, notification: CardNotification): CardRecord {
  if (!acceptsCardNotifications(card.lifecycle.status)) throw new Error(`Cannot queue notification for terminal card '${card.id}' in status '${card.lifecycle.status}'.`);
  const parsed = cardNotificationSchema.parse(notification);
  if (card.pending_notifications.some((candidate) => candidate.id === parsed.id)) throw new Error(`Notification '${parsed.id}' already exists on card '${card.id}'.`);
  return { ...card, pending_notifications: [...card.pending_notifications, parsed] };
}

export function removeCardNotifications(card: CardRecord, notificationIds: readonly string[]): CardRecord {
  if (notificationIds.length === 0) throw new Error('Notification removal requires at least one id.');
  const selected = new Set(notificationIds);
  if (selected.size !== notificationIds.length) throw new Error('Notification removal ids must be unique.');
  for (const id of selected) if (!card.pending_notifications.some((notification) => notification.id === id)) throw new Error(`Notification '${id}' is not pending on card '${card.id}'.`);
  return { ...card, pending_notifications: card.pending_notifications.filter((notification) => !selected.has(notification.id)) };
}
