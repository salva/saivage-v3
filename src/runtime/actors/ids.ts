import { conversationSessionIdentity, parseConversationSessionId, type ConversationRole, type ConversationSessionId } from '../../schemas/index.js';

export function plannerActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`planner:${cardId}`);
}

export function reviewerActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`reviewer:${cardId}`);
}

export function executorActorId(cardId: string): ConversationSessionId {
  return parseConversationSessionId(`executor:${cardId}`);
}

export function parseLlmActorId(actorId: string): { role: ConversationRole; cardId: string | null } {
  const identity = conversationSessionIdentity(parseConversationSessionId(actorId));
  return { role: identity.role, cardId: identity.cardId };
}
