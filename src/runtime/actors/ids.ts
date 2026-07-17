import type { ActorKind, LlmActorRole } from '../../schemas/actor-vocabulary.js';
import { conversationSessionIdentity, parseConversationSessionId, type ConversationSessionId } from '../../schemas/index.js';

export { actorKindSchema, actorKinds, llmActorRoleSchema, llmActorRoles } from '../../schemas/actor-vocabulary.js';
export type { ActorKind, LlmActorRole } from '../../schemas/actor-vocabulary.js';

export function cardActorId(cardId: string): string {
  return `card:${cardId}`;
}

export function plannerActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`planner:${cardId}`);
}

export function reviewerActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`reviewer:${cardId}`);
}

export function executorActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`executor:${cardId}`);
}

export function processorActorId(cardId: string): string {
  return `processor:${cardId}`;
}

export function actorKindFromId(actorId: string): ActorKind {
  if (actorId.startsWith('card:')) return 'card';
  try { parseConversationSessionId(actorId); return 'llm'; } catch { /* continue */ }
  if (actorId.startsWith('processor:')) return 'processor';
  throw new Error(`Unknown actor id: ${actorId}`);
}

export function parseCardActorId(actorId: string): string {
  if (!actorId.startsWith('card:')) throw new Error(`Expected card actor id, received '${actorId}'.`);
  const cardId = actorId.slice('card:'.length);
  if (cardId.length === 0) throw new Error(`Expected card actor id with a card id, received '${actorId}'.`);
  return cardId;
}

export function parseLlmActorId(actorId: string): { role: LlmActorRole; cardId: string | null } {
  const identity = conversationSessionIdentity(parseConversationSessionId(actorId));
  return { role: identity.role, cardId: identity.cardId };
}

export function cardIdFromSessionId(sessionId: ConversationSessionId): string | undefined {
  const parsed = parseLlmActorId(sessionId);
  return parsed.cardId ?? undefined;
}

export function agentIdFromSessionId(sessionId: ConversationSessionId): string {
  if (conversationSessionIdentity(sessionId).role === 'reviewer') {
    const cardId = cardIdFromSessionId(sessionId);
    if (!cardId) throw new Error(`Reviewer session '${sessionId}' is missing a card id.`);
    return reviewerActorId(cardId);
  }
  return sessionId;
}

export function isAutonomousLlmSession(sessionId: ConversationSessionId): boolean {
  const { role } = parseLlmActorId(agentIdFromSessionId(sessionId));
  return role === 'planner' || role === 'reviewer' || role === 'executor';
}

export function parseProcessorActorId(actorId: string): string {
  if (!actorId.startsWith('processor:')) throw new Error(`Expected processor actor id, received '${actorId}'.`);
  return actorId.slice('processor:'.length);
}
