import { cardAgentSessionId, conversationSessionIdentity, parseConversationSessionId, type AgentName, type ConversationSessionId } from '../../schemas/index.js';

export function namedCardActorId(agentName: AgentName, cardId: string): ConversationSessionId { return cardAgentSessionId(agentName, cardId); }
export function parseLlmActorId(actorId: string): { agentName: AgentName; cardId: string | null } {
  const identity = conversationSessionIdentity(parseConversationSessionId(actorId));
  return { agentName: identity.agentName, cardId: identity.cardId };
}
