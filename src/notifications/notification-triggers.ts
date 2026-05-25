import { join } from 'node:path';
import { createNotificationDeliveryService } from './notification-delivery.js';
import { CardStore } from '../cards/index.js';
import { listSessions, getSession } from '../agents/index.js';
import type { AgentRole, AgentSession, ControlActionSurface, NoteAuthor } from '../schemas/index.js';

export interface NotificationTriggerTarget {
  sessionId: string;
  role: AgentRole;
}

export type NotificationSourceMeta = {
  actor: NoteAuthor;
  surface: ControlActionSurface;
};

export type Recipient =
  | { kind: 'card'; cardId: string }
  | { kind: 'role'; role: AgentRole }
  | { kind: 'session'; sessionId: string };

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

function resolveSessionIds(projectRoot: string, recipient: Recipient): string[] {
  if (recipient.kind === 'session') return [recipient.sessionId];
  if (recipient.kind === 'role') return getActiveSessions(projectRoot).filter((session) => session.role === recipient.role).map((session) => session.id);
  return findAffectedActiveSessionsForCard(projectRoot, recipient.cardId).map((target) => target.sessionId);
}

export function resolveRecipient(projectRoot: string, recipientLiteral: string): Recipient | null {
  const literal = recipientLiteral.trim();
  if (!literal) return null;
  const store = new CardStore(projectRoot);
  if (store.read(literal)) return { kind: 'card', cardId: literal };
  const roles: AgentRole[] = ['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor'];
  if ((roles as string[]).includes(literal)) return { kind: 'role', role: literal as AgentRole };
  if (getActiveSessions(projectRoot).some((session) => session.id === literal)) return { kind: 'session', sessionId: literal };
  return null;
}

export function queueNotification(
  projectRoot: string,
  recipient: Recipient,
  kind: string,
  body: string,
  source: NotificationSourceMeta,
): void {
  const delivery = createNotificationDeliveryService(projectRoot);
  const queued_at = new Date().toISOString();
  for (const sessionId of resolveSessionIds(projectRoot, recipient)) {
    delivery.enqueue(sessionId, { kind, body, queued_at, source_actor: source.actor, source_surface: source.surface });
  }
}
