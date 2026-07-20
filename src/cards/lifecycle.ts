import { cardNotificationSchema, isTerminalCardType, type CardNotification, type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import { acceptsCardNotifications } from './card-status.js';
import { valuesEqual } from './value-equality.js';

export interface CardMutationContext {
  actor: import('../schemas/index.js').NoteAuthor;
  surface: import('../schemas/index.js').ControlActionSurface;
  reason?: string;
}

export interface NewCardInput {
  type: CardType;
  parent: string;
  title: string;
  brief: string;
  subtype?: string | null;
  tags: string[];
  priority: number;
  urgency: import('../schemas/index.js').Urgency;
  created_by: import('../schemas/index.js').CreatedBy;
  assigned_to?: string | null;
  depends_on: string[];
  related: string[];
  metrics?: Record<string, number | string | boolean | null> | null;
  estimate?: string | null;
  started_at?: string | null;
  duration_ms?: number | null;
  status_text?: string | null;
  status_text_updated_at?: string | null;
  status_text_author_session_id?: string | null;
  latest_self_report?: Record<string, unknown> | null;
  metadata?: import('../schemas/index.js').CardMetadata | null;
}

export type CardPatch = Partial<Pick<CardRecord,
  | 'title' | 'subtype' | 'tags' | 'priority' | 'urgency' | 'assigned_to'
  | 'depends_on' | 'related' | 'metrics' | 'estimate' | 'started_at'
  | 'duration_ms' | 'status_text' | 'status_text_updated_at'
  | 'status_text_author_session_id' | 'latest_self_report' | 'metadata'
  | 'pending_notifications'>>;

export type TerminalLifecycleCommit =
  | {
      lifecycle: Extract<CardLifecycleState, { status: 'done' }>;
      status_text?: string | null;
      status_text_updated_at?: string | null;
    }
  | {
      lifecycle: Extract<CardLifecycleState, { status: 'failed' }>;
      status_text?: string | null;
      status_text_updated_at?: string | null;
    }
  | {
      lifecycle: Extract<CardLifecycleState, { status: 'blocked' }>;
      status_text?: string | null;
      status_text_updated_at?: string | null;
    };

export type SetStatusTarget = Exclude<CardStatus, 'stopped' | 'done' | 'failed'>;
export type SetStatusLifecycle = Extract<CardLifecycleState, { status: SetStatusTarget }>;

const CRITICAL_FIELDS: ReadonlySet<string> = new Set([
  'depends_on',
]);

const ALWAYS_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'metrics',
  'duration_ms',
  'started_at',
  'status_text',
  'status_text_updated_at',
  'status_text_author_session_id',
  'latest_self_report',
]);

const FULL_EDIT_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>(['backlog', 'stopped']);

const LIFECYCLE_LOCKED_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'done',
  'failed',
  'blocked',
  'cancelled',
]);

const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  backlog: ['running', 'cancelled'],
  running: ['done', 'failed', 'blocked', 'changed', 'cancelled', 'backlog'],
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'running', 'cancelled'],
  stopped: ['cancelled'],
  done: ['changed'],
  failed: ['cancelled', 'changed'],
  cancelled: [],
};

const TRACKED_FIELDS = [
  'title',
  'subtype',
  'tags',
  'priority',
  'urgency',
  'estimate',
  'depends_on',
  'related',
  'assigned_to',
] as const satisfies ReadonlyArray<keyof CardRecord>;

export function isTerminalType(type: CardType): boolean {
  return isTerminalCardType(type);
}

export function canTransition(from: CardStatus, to: CardStatus): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

export function validateTransition(from: CardStatus, to: CardStatus): void {
  if (canTransition(from, to)) return;
  const allowed = VALID_TRANSITIONS[from];
  throw new Error(
    `Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${allowed ? allowed.join(', ') : 'none'}.`,
  );
}

export function buildSetStatusLifecycle(
  card: CardRecord,
  newStatus: SetStatusTarget,
): SetStatusLifecycle {
  switch (newStatus) {
    case 'backlog':
    case 'running':
    case 'changed':
    case 'cancelled':
      return { status: newStatus, result: null, error: null, completed_at: null };
    case 'blocked': {
      const blockedReason = `Card '${card.id}' was marked blocked via setStatus.`;
      return {
        status: 'blocked',
        result: {
          kind: 'blocked',
          summary: blockedReason,
          resume_reason: 'manual_blocked_status',
          blocker_cause: 'generic',
        },
        error: blockedReason,
        completed_at: null,
      };
    }
  }
}

export function buildStoppedLifecycle(): Extract<CardLifecycleState, { status: 'stopped' }> {
  return { status: 'stopped', result: null, error: null, completed_at: null };
}

export function buildActivatedStoppedLifecycle(): Extract<CardLifecycleState, { status: 'running' }> {
  return { status: 'running', result: null, error: null, completed_at: null };
}

export function summarizeChangedFields(changedFields: string[]): string {
  if (changedFields.length === 0) return 'card updated';
  return `${changedFields.join(', ')} updated`;
}

export function prunePartialPatch(
  existing: CardRecord,
  changes: CardPatch,
): CardPatch {
  const changed = <T>(current: T | undefined, candidate: T | undefined): candidate is T => candidate !== undefined && !valuesEqual(current, candidate);
  return {
    ...(changed(existing.title, changes.title) ? { title: changes.title } : {}),
    ...(changed(existing.subtype, changes.subtype) ? { subtype: changes.subtype } : {}),
    ...(changed(existing.tags, changes.tags) ? { tags: changes.tags } : {}),
    ...(changed(existing.priority, changes.priority) ? { priority: changes.priority } : {}),
    ...(changed(existing.urgency, changes.urgency) ? { urgency: changes.urgency } : {}),
    ...(changed(existing.assigned_to, changes.assigned_to) ? { assigned_to: changes.assigned_to } : {}),
    ...(changed(existing.depends_on, changes.depends_on) ? { depends_on: changes.depends_on } : {}),
    ...(changed(existing.related, changes.related) ? { related: changes.related } : {}),
    ...(changed(existing.metrics, changes.metrics) ? { metrics: changes.metrics } : {}),
    ...(changed(existing.estimate, changes.estimate) ? { estimate: changes.estimate } : {}),
    ...(changed(existing.started_at, changes.started_at) ? { started_at: changes.started_at } : {}),
    ...(changed(existing.duration_ms, changes.duration_ms) ? { duration_ms: changes.duration_ms } : {}),
    ...(changed(existing.status_text, changes.status_text) ? { status_text: changes.status_text } : {}),
    ...(changed(existing.status_text_updated_at, changes.status_text_updated_at) ? { status_text_updated_at: changes.status_text_updated_at } : {}),
    ...(changed(existing.status_text_author_session_id, changes.status_text_author_session_id) ? { status_text_author_session_id: changes.status_text_author_session_id } : {}),
    ...(changed(existing.latest_self_report, changes.latest_self_report) ? { latest_self_report: changes.latest_self_report } : {}),
    ...(changed(existing.metadata, changes.metadata) ? { metadata: changes.metadata } : {}),
    ...(changed(existing.pending_notifications, changes.pending_notifications) ? { pending_notifications: changes.pending_notifications } : {}),
  };
}

export function validateMutablePatch(
  existing: CardRecord,
  changes: CardPatch,
): void {
  const changedKeys = Object.keys(changes);

  const status = existing.lifecycle.status;
  if (LIFECYCLE_LOCKED_STATES.has(status)) {
    for (const key of changedKeys) {
      if (status === 'blocked' && key === 'pending_notifications') continue;
      if (!ALWAYS_ALLOWED_FIELDS.has(key)) {
        throw new Error(
          `Card '${existing.id}' is in status '${status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`,
        );
      }
    }
  } else if (!FULL_EDIT_STATES.has(status)) {
    for (const key of changedKeys) {
      if (CRITICAL_FIELDS.has(key)) {
        throw new Error(
          `Field '${key}' cannot be changed on a card in status '${status}'. Cards in this state allow editing: title, priority, urgency, tags, and other non-structural fields.`,
        );
      }
    }
  }
}

export function buildUpdatedCard(
  existing: CardRecord,
  changes: CardPatch,
  stamp: string,
): CardRecord {
  validateMutablePatch(existing, changes);
  const newDependsOn =
    changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;
  return {
    ...existing,
    ...changes,
    id: existing.id,
    created_at: existing.created_at,
    created_by: existing.created_by,
    updated_at: stamp,
    depends_on: newDependsOn,
    pending_notifications: acceptsCardNotifications(existing.lifecycle.status)
      ? changes.pending_notifications ?? existing.pending_notifications
      : [],
    version_seq: existing.version_seq + 1,
  };
}

export function collectChangedFields(
  existing: CardRecord,
  candidate: CardRecord,
  changes: CardPatch,
): string[] {
  const changedFields: string[] = [];
  for (const f of TRACKED_FIELDS) {
    if (changes[f] !== undefined && !valuesEqual(existing[f], candidate[f])) {
      changedFields.push(f);
    }
  }
  for (const k of Object.keys(changes)) {
    if (!changedFields.includes(k)) changedFields.push(k);
  }
  return changedFields;
}

export function briefContentForNewCard(input: NewCardInput): string {
  return input.brief;
}

export function enqueueCardNotification(card: CardRecord, notification: CardNotification): CardRecord {
  if (!acceptsCardNotifications(card.lifecycle.status)) throw new Error(`Cannot queue notification for terminal card '${card.id}' in status '${card.lifecycle.status}'.`);
  const parsed = cardNotificationSchema.parse(notification);
  if (card.pending_notifications.some((candidate) => candidate.id === parsed.id)) throw new Error(`Notification '${parsed.id}' already exists on card '${card.id}'.`);
  return { ...card, pending_notifications: [...card.pending_notifications, parsed] };
}

export function removeCardNotifications(card: CardRecord, notificationIds: readonly string[]): CardRecord {
  const selected = new Set(notificationIds);
  if (selected.size !== notificationIds.length) throw new Error('Notification removal ids must be unique.');
  for (const id of selected) if (!card.pending_notifications.some((notification) => notification.id === id)) throw new Error(`Notification '${id}' is not pending on card '${card.id}'.`);
  return { ...card, pending_notifications: card.pending_notifications.filter((notification) => !selected.has(notification.id)) };
}
