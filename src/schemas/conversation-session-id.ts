import { z } from 'zod';
import { agentNameSchema, type AgentName } from './agent-name.js';
import { cardIdSchema, type CardId } from './card-id.js';

export type GlobalConversationSessionId = `agent:${AgentName}:global`;
export type CardConversationSessionId = `agent:${AgentName}:${CardId}`;
export type ConversationSessionId = GlobalConversationSessionId | CardConversationSessionId;
const SESSION_PATTERN = /^agent:([a-z][a-z0-9-]{0,63}):(.+)$/u;

export const ConversationSessionIdSchema: z.ZodType<ConversationSessionId> = z.custom<ConversationSessionId>((value) => {
  if (typeof value !== 'string') return false;
  const match = SESSION_PATTERN.exec(value);
  return match !== null && agentNameSchema.safeParse(match[1]).success && (match[2] === 'global' || cardIdSchema.safeParse(match[2]).success);
}, 'Expected an exact named-agent conversation session id.');
export function parseConversationSessionId(value: unknown): ConversationSessionId { return ConversationSessionIdSchema.parse(value); }
export function globalAgentSessionId(agentName: AgentName): GlobalConversationSessionId { return parseConversationSessionId(`agent:${agentName}:global`) as GlobalConversationSessionId; }
export function cardAgentSessionId(agentName: AgentName, cardId: string): CardConversationSessionId { return parseConversationSessionId(`agent:${agentName}:${cardId}`) as CardConversationSessionId; }
export function conversationSessionIdentity(sessionId: ConversationSessionId): { readonly sessionId: ConversationSessionId; readonly agentName: AgentName; readonly cardId: CardId | null } {
  const match = SESSION_PATTERN.exec(sessionId)!;
  return { sessionId, agentName: agentNameSchema.parse(match[1]), cardId: match[2] === 'global' ? null : cardIdSchema.parse(match[2]) };
}
