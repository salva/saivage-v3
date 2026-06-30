import { createNotificationDeliveryService } from './notification-delivery.js';
import type { CardStore } from '../cards/store-api.js';
import type { AgentRole, AgentSession, ControlActionSurface, NoteAuthor } from '../schemas/index.js';
import { readActorSnapshots } from '../runtime/actors/snapshots.js';

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
  return readActorSnapshots(projectRoot)
    .filter((snapshot) => snapshot.actor_kind === 'llm')
    .flatMap((snapshot) => parseAgentSessionId(snapshot.actor_id));
}

function parseAgentSessionId(sessionId: string): AgentSession[] {
  if (sessionId.startsWith('analyst:')) return [{ id: sessionId, role: 'analyst', status: 'active', started_at: new Date(0).toISOString() }];
  if (sessionId.startsWith('planner:')) {
    const goalId = sessionId.slice('planner:'.length);
    return [{ id: sessionId, role: 'planner', goal_card_id: goalId, card_id: goalId, status: 'active', started_at: new Date(0).toISOString() }];
  }
  if (sessionId.startsWith('executor:')) {
    const cardId = sessionId.slice('executor:'.length);
    return [{ id: sessionId, role: 'executor', card_id: cardId, status: 'active', started_at: new Date(0).toISOString() }];
  }
  if (sessionId.startsWith('reviewer:')) {
    const rest = sessionId.slice('reviewer:'.length);
    const separator = rest.indexOf(':');
    if (separator === -1) return [];
    const goalId = rest.slice(0, separator);
    const assessmentId = rest.slice(separator + 1);
    return [{ id: sessionId, role: 'reviewer', goal_card_id: goalId, card_id: goalId, assessment_id: assessmentId, status: 'active', started_at: new Date(0).toISOString() }];
  }
  return [];
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

export function findAffectedActiveSessionsForCard(projectRoot: string, store: CardStore, cardId: string): NotificationTriggerTarget[] {
  const scope = buildAncestorScope(store, cardId);
  return getActiveSessions(projectRoot)
    .filter((session) => sessionIsAffectedByCardChange(store, session, cardId, scope))
    .map((session) => ({ sessionId: session.id, role: session.role }));
}

function resolveSessionIds(projectRoot: string, recipient: Recipient, store?: CardStore): string[] {
  if (recipient.kind === 'session') return [recipient.sessionId];
  if (recipient.kind === 'role') return getActiveSessions(projectRoot).filter((session) => session.role === recipient.role).map((session) => session.id);
  if (!store) throw new Error('CardStore is required to resolve card notification recipients.');
  return findAffectedActiveSessionsForCard(projectRoot, store, recipient.cardId).map((target) => target.sessionId);
}

export function resolveRecipient(projectRoot: string, store: CardStore, recipientLiteral: string): Recipient | null {
  const literal = recipientLiteral.trim();
  if (!literal) return null;
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
  store?: CardStore,
): void {
  const delivery = createNotificationDeliveryService(projectRoot);
  const queued_at = new Date().toISOString();
  for (const sessionId of resolveSessionIds(projectRoot, recipient, store)) {
    delivery.enqueue(sessionId, { kind, body, queued_at, source_actor: source.actor, source_surface: source.surface });
  }
}
