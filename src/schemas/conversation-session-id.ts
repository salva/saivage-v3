import { z } from 'zod';

import { cardIdSchema, type CardId } from './card-id.js';

export const GLOBAL_ANALYST_SESSION_ID = 'analyst:global' as const;
export type AnalystConversationSessionId = typeof GLOBAL_ANALYST_SESSION_ID;
export type PlannerConversationSessionId = `planner:${CardId}`;
export type ReviewerConversationSessionId = `reviewer:${CardId}`;
export type ExecutorConversationSessionId = `executor:${CardId}`;
export type CardConversationSessionId = PlannerConversationSessionId | ReviewerConversationSessionId | ExecutorConversationSessionId;
export type ConversationSessionId = AnalystConversationSessionId | CardConversationSessionId;
export type ConversationRole = 'analyst' | 'planner' | 'reviewer' | 'executor';

const CARD_SESSION_PATTERN = /^(planner|reviewer|executor):(.+)$/u;

function isConversationSessionId(value: unknown): value is ConversationSessionId {
  if (value === GLOBAL_ANALYST_SESSION_ID) return true;
  if (typeof value !== 'string') return false;
  const match = CARD_SESSION_PATTERN.exec(value);
  return match !== null && cardIdSchema.safeParse(match[2]).success;
}

export const AnalystConversationSessionIdSchema: z.ZodType<AnalystConversationSessionId> = z.literal(GLOBAL_ANALYST_SESSION_ID);
export const PlannerConversationSessionIdSchema: z.ZodType<PlannerConversationSessionId> = z.custom<PlannerConversationSessionId>((value) => typeof value === 'string' && value.startsWith('planner:') && cardIdSchema.safeParse(value.slice('planner:'.length)).success);
export const ReviewerConversationSessionIdSchema: z.ZodType<ReviewerConversationSessionId> = z.custom<ReviewerConversationSessionId>((value) => typeof value === 'string' && value.startsWith('reviewer:') && cardIdSchema.safeParse(value.slice('reviewer:'.length)).success);
export const ExecutorConversationSessionIdSchema: z.ZodType<ExecutorConversationSessionId> = z.custom<ExecutorConversationSessionId>((value) => typeof value === 'string' && value.startsWith('executor:') && cardIdSchema.safeParse(value.slice('executor:'.length)).success);
export const ConversationSessionIdSchema: z.ZodType<ConversationSessionId> = z.custom<ConversationSessionId>(isConversationSessionId, 'Expected an exact canonical conversation session id.');

export function parseConversationSessionId(value: unknown): ConversationSessionId {
  return ConversationSessionIdSchema.parse(value);
}

export function conversationSessionIdentity(sessionId: ConversationSessionId): { readonly sessionId: ConversationSessionId; readonly role: ConversationRole; readonly cardId: CardId | null } {
  if (sessionId === GLOBAL_ANALYST_SESSION_ID) return { sessionId, role: 'analyst', cardId: null };
  const separator = sessionId.indexOf(':');
  const role = sessionId.slice(0, separator);
  const cardId = cardIdSchema.parse(sessionId.slice(separator + 1));
  if (role !== 'planner' && role !== 'reviewer' && role !== 'executor') throw new Error(`Unreachable conversation role '${role}'.`);
  return { sessionId, role, cardId };
}
