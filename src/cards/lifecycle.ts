import { cardNotificationSchema, isTerminalCardType, type CardNotification, type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import type { CardLifecycleState } from '../schemas/index.js';
import { PROJECT_CARD_ID } from './project-card.js';
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
  status: CardStatus;
  subtype?: string | null;
  tags: string[];
  priority: number;
  urgency: import('../schemas/index.js').Urgency;
  created_by: import('../schemas/index.js').CreatedBy;
  assigned_to?: string | null;
  depends_on: string[];
  related: string[];
  lifecycle?: CardLifecycleState;
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

export type CardPatch = Partial<Omit<CardRecord, 'type' | 'children'>>;

const CRITICAL_FIELDS: ReadonlySet<string> = new Set([
  'parent',
  'depends_on',
  'depth',
  'id',
  'created_at',
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

const TERMINAL_LIFECYCLE_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'lifecycle',
]);

const EXPLICIT_LIFECYCLE_WRITE_REASONS: ReadonlySet<string> = new Set([
  'terminal lifecycle commit',
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
  'parent',
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
  newStatus: CardStatus,
): CardRecord['lifecycle'] {
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
    default:
      return card.lifecycle;
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
  const pruned: CardPatch = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const current = (existing as unknown as Record<string, unknown>)[key];
    if (valuesEqual(current, value)) continue;
    (pruned as Record<string, unknown>)[key] = value;
  }
  return pruned;
}

export function assertGenericCardPatch(changes: CardPatch): void {
  if (Object.hasOwn(changes, 'children')) throw new Error("Field 'children' cannot be changed via update/mutateCard; use the dedicated child link or reorder operation.");
}

export function validateMutablePatch(
  existing: CardRecord,
  changes: CardPatch,
  ctx?: CardMutationContext,
): number {
  const changedKeys = Object.keys(changes);
  const changesLifecycleField = changedKeys.some((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
  const reopensLifecycle = changes.status !== undefined && changes.status !== existing.status && !LIFECYCLE_LOCKED_STATES.has(changes.status);
  const explicitLifecycleWrite = ctx?.surface === 'runtime' && ctx.actor === 'runtime' && !!ctx.reason && EXPLICIT_LIFECYCLE_WRITE_REASONS.has(ctx.reason);
  const explicitStatusTransition =
    (changedKeys.length === 1 || (changedKeys.length === 2 && changedKeys.includes('lifecycle'))) &&
    changes.status !== undefined &&
    ctx?.surface === 'runtime' &&
    ctx.actor === 'runtime' &&
    typeof ctx.reason === 'string' &&
    (ctx.reason.startsWith('status -> ') || ctx.reason === 'recovery stopped lifecycle' || ctx.reason === 'STOPPED activation');

  if (changesLifecycleField && !explicitLifecycleWrite && !explicitStatusTransition) {
    const fields = changedKeys.filter((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
    throw new Error(
      `Fields ${fields.join(', ')} are lifecycle-owned and can only be changed by terminal commit or setStatus transition paths.`,
    );
  }

  if (LIFECYCLE_LOCKED_STATES.has(existing.status) && changesLifecycleField && !reopensLifecycle && !explicitLifecycleWrite && !explicitStatusTransition) {
    const fields = changedKeys.filter((key) => TERMINAL_LIFECYCLE_FIELDS.has(key));
    throw new Error(
      `Card '${existing.id}' is in status '${existing.status}'. Fields ${fields.join(', ')} are lifecycle-owned and can only be changed by terminal commit or setStatus reopening paths. Reopen the card before ordinary edits.`,
    );
  }

  if (LIFECYCLE_LOCKED_STATES.has(existing.status)) {
    for (const key of changedKeys) {
      if ((explicitLifecycleWrite || explicitStatusTransition) && TERMINAL_LIFECYCLE_FIELDS.has(key)) continue;
      if (existing.status === 'blocked' && key === 'pending_notifications') continue;
      if (key !== 'status' && !ALWAYS_ALLOWED_FIELDS.has(key)) {
        throw new Error(
          `Card '${existing.id}' is in status '${existing.status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`,
        );
      }
    }
  } else if (!FULL_EDIT_STATES.has(existing.status)) {
    for (const key of changedKeys) {
      if (CRITICAL_FIELDS.has(key)) {
        throw new Error(
          `Field '${key}' cannot be changed on a card in status '${existing.status}'. Cards in this state allow editing: status, title, priority, urgency, tags, and other non-structural fields.`,
        );
      }
    }
  }
  if (changes.parent !== undefined && changes.parent !== existing.parent) {
    throw new Error("Field 'parent' cannot be changed via update/mutateCard; card reparenting is not supported.");
  }
  return existing.depth;
}

export function buildUpdatedCard(
  existing: CardRecord,
  changes: CardPatch,
  stamp: string,
  ctx?: CardMutationContext,
): CardRecord {
  const newDepth = validateMutablePatch(existing, changes, ctx);
  const newDependsOn =
    changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;
  const status = changes.status ?? existing.status;
  return {
    ...existing,
    ...changes,
    id: existing.id,
    created_at: existing.created_at,
    created_by: existing.created_by,
    updated_at: stamp,
    depth: newDepth,
    depends_on: newDependsOn,
    pending_notifications: acceptsCardNotifications(status)
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

export function assertCanCreateCard(input: NewCardInput): void {
  if ((input as { type: string }).type === 'plan') {
    throw new Error('Plan cards are no longer created. Planning state lives on goal cards.');
  }
  if (input.type === 'project' && input.parent !== null) {
    throw new Error(`Project card '${PROJECT_CARD_ID}' must be the root card and cannot have parent '${input.parent}'.`);
  }
}

export function briefContentForNewCard(input: NewCardInput): string {
  return input.brief;
}

export function enqueueCardNotification(card: CardRecord, notification: CardNotification): CardRecord {
  if (!acceptsCardNotifications(card.status)) throw new Error(`Cannot queue notification for terminal card '${card.id}' in status '${card.status}'.`);
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
