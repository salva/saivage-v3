import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createNotificationDeliveryService } from './notification-delivery.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { CardStore } from '../cards/index.js';
import { listSessions, getSession } from '../agents/index.js';
import type {
  AgentRole,
  AgentSession,
  CardRecord,
  ControlActionSurface,
  NoteAuthor,
  NoteKind,
  ProcessRecord,
} from '../schemas/index.js';

export interface NotificationTriggerTarget {
  sessionId: string;
  role: AgentRole;
}

export type NotificationSourceMeta = {
  actor: NoteAuthor;
  surface: ControlActionSurface;
};

const BLOCKING_CARD_FIELDS = new Set(['acceptance', 'description', 'instructions_file', 'depends_on']);

function makeNotificationId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function summarize(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function redactNotificationSummary(summary: string): string {
  return summarize(redactTextForOutbound(summary, 'notification.transport', { source: 'notification-triggers' }));
}

function getActiveSessions(projectRoot: string): AgentSession[] {
  const saivageDir = join(projectRoot, '.saivage');
  return listSessions(saivageDir)
    .map((sessionId) => getSession(saivageDir, sessionId))
    .filter((session): session is AgentSession => session !== null && (session.status === 'active' || session.status === 'waiting'));
}

function buildAncestorScope(store: CardStore, cardId: string): Set<string> {
  const scope = new Set(store.getAncestors(cardId));
  scope.add(cardId);
  return scope;
}

function sessionIsAffectedByCardChange(store: CardStore, session: AgentSession, cardId: string, scope: Set<string>): boolean {
  if (session.card_id === cardId) return true;

  if (session.card_id && store.isDescendantOf(session.card_id, cardId)) {
    if (session.goal_card_id === cardId) return true;
    if (session.goal_card_id && scope.has(session.goal_card_id)) return true;
  }

  return session.goal_card_id ? scope.has(session.goal_card_id) : false;
}

export function findAffectedActiveSessionsForCard(projectRoot: string, cardId: string): NotificationTriggerTarget[] {
  const store = new CardStore(projectRoot);
  const scope = buildAncestorScope(store, cardId);
  return getActiveSessions(projectRoot)
    .filter((session) => sessionIsAffectedByCardChange(store, session, cardId, scope))
    .map((session) => ({ sessionId: session.id, role: session.role }));
}

function enqueueSessionAndOperatorNotifications(
  projectRoot: string,
  targets: string[],
  input: {
    kind: 'card_changed' | 'note_added' | 'process_state' | 'runtime_state' | 'config_changed';
    severity: 'info' | 'warn' | 'block';
    payload_summary: string;
    related_card_id?: string;
    related_note_id?: string;
    related_process_id?: string;
    related_version_seq?: number;
    source_actor: NoteAuthor;
    source_surface: ControlActionSurface;
  },
): void {
  const delivery = createNotificationDeliveryService(projectRoot);
  const summary = redactNotificationSummary(input.payload_summary);
  for (const sessionId of targets) {
    delivery.enqueueForSession(sessionId, {
      ...input,
      id: makeNotificationId(input.kind),
      payload_summary: summary,
    });
  }
  delivery.enqueueForOperator({
    ...input,
    id: makeNotificationId(`${input.kind}-operator`),
    payload_summary: summary,
  });
}

export function enqueueCardMutationNotifications(
  projectRoot: string,
  card: CardRecord,
  changedFields: string[],
  source: NotificationSourceMeta,
): void {
  const targets = findAffectedActiveSessionsForCard(projectRoot, card.id).map((target) => target.sessionId);
  const severity = changedFields.some((field) => BLOCKING_CARD_FIELDS.has(field)) ? 'block' : 'warn';
  enqueueSessionAndOperatorNotifications(projectRoot, targets, {
    kind: 'card_changed',
    severity,
    payload_summary: `Card ${card.id} updated (${changedFields.join(', ')}) at version ${card.version_seq}. Use diff_card to inspect the change.`,
    related_card_id: card.id,
    related_version_seq: card.version_seq,
    source_actor: source.actor,
    source_surface: source.surface,
  });
}

export function enqueueNoteNotifications(
  projectRoot: string,
  note: { id: string; card_id: string; kind: NoteKind; content: string },
  source: NotificationSourceMeta,
): void {
  const targets = note.kind === 'directive' || note.kind === 'escalation'
    ? findAffectedActiveSessionsForCard(projectRoot, note.card_id).map((target) => target.sessionId)
    : [];
  const severity = note.kind === 'escalation' ? 'block' : note.kind === 'directive' ? 'warn' : 'info';
  enqueueSessionAndOperatorNotifications(projectRoot, targets, {
    kind: 'note_added',
    severity,
    payload_summary: `Note ${note.id} (${note.kind}) added on card ${note.card_id}: ${note.content}`,
    related_card_id: note.card_id,
    related_note_id: note.id,
    source_actor: source.actor,
    source_surface: source.surface,
  });
}

export function enqueueRuntimeStateNotifications(
  projectRoot: string,
  event: 'paused' | 'resumed',
  source: NotificationSourceMeta,
): void {
  const targets = getActiveSessions(projectRoot).map((session) => session.id);
  enqueueSessionAndOperatorNotifications(projectRoot, targets, {
    kind: 'runtime_state',
    severity: event === 'paused' ? 'block' : 'info',
    payload_summary: event === 'paused'
      ? 'Runtime was paused. Acknowledge this notification before finalizing work.'
      : 'Runtime was resumed. Continue work using the latest runtime state.',
    source_actor: source.actor,
    source_surface: source.surface,
  });
}

export function enqueueProcessKillNotifications(
  projectRoot: string,
  processRecord: ProcessRecord,
  source: NotificationSourceMeta,
): void {
  const targets = processRecord.agent_session_id ? [processRecord.agent_session_id] : [];
  enqueueSessionAndOperatorNotifications(projectRoot, targets, {
    kind: 'process_state',
    severity: 'warn',
    payload_summary: `Process ${processRecord.id} for card ${processRecord.card_id} was terminated (status: ${processRecord.status}).`,
    related_card_id: processRecord.card_id,
    related_process_id: processRecord.id,
    source_actor: source.actor,
    source_surface: source.surface,
  });
}

export function enqueueProcessReconciliationNotification(
  projectRoot: string,
  processRecord: ProcessRecord,
  eventKind: 'process_reconciled_dead' | 'process_reattach_rejected',
  detail: string,
  source: NotificationSourceMeta,
): void {
  const targets = processRecord.agent_session_id ? [processRecord.agent_session_id] : [];
  const action = eventKind === 'process_reconciled_dead' ? 'reconciled as dead during restart' : 'reattach was rejected during restart';
  enqueueSessionAndOperatorNotifications(projectRoot, targets, {
    kind: 'process_state',
    severity: 'warn',
    payload_summary: `Process ${processRecord.id} for card ${processRecord.card_id} ${action}: ${detail}`,
    related_card_id: processRecord.card_id,
    related_process_id: processRecord.id,
    source_actor: source.actor,
    source_surface: source.surface,
  });
}

export function buildConfigChangedTargets(projectRoot: string, roles: AgentRole[]): string[] {
  const allowed = new Set(roles);
  return getActiveSessions(projectRoot)
    .filter((session) => allowed.has(session.role))
    .map((session) => session.id);
}
