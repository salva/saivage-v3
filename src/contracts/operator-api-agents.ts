import { z } from 'zod';
import { providerExchangePayloadSchema } from './provider-exchange.js';
import {
  agentMessageSchema,
  agentNameSchema,
  cardIdSchema,
  ConversationSessionIdSchema,
  conversationSessionIdentity,
} from '../schemas/index.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const AgentSessionParamsSchema = z.object({ id: ConversationSessionIdSchema }).strict();
export const AgentConversationParamsSchema = AgentSessionParamsSchema;
export const AgentLlmExchangeParamsSchema = AgentSessionParamsSchema;
export const CardAgentSessionsParamsSchema = z.object({ id: cardIdSchema }).strict();
export const AgentConversationQuerySchema = z
  .object({ since: z.string().min(1).optional() })
  .strict();
const agentSessionBase = z
  .object({
    id: ConversationSessionIdSchema,
    agent_name: agentNameSchema,
    session_scope: z.enum(['global', 'card']),
    card_id: cardIdSchema.nullable(),
    started_at: z.string().datetime(),
  })
  .strict();
function requireMatchingIdentity(
  value: z.infer<typeof agentSessionBase>,
  ctx: z.RefinementCtx,
): void {
  const identity = conversationSessionIdentity(value.id);
  if (value.agent_name !== identity.agentName)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent_name'],
      message: 'Agent name must match session identity.',
    });
  if (value.card_id !== identity.cardId)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['card_id'],
      message: 'Card ownership must match session identity.',
    });
  if (value.session_scope !== (identity.cardId === null ? 'global' : 'card'))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['session_scope'],
      message: 'Session scope must match identity.',
    });
}
export const AgentSessionSummarySchema = agentSessionBase.superRefine(requireMatchingIdentity);
export const AgentConversationEntrySchema = agentMessageSchema;
export const AgentListResponseSchema = z
  .object({
    sessions: z.array(AgentSessionSummarySchema),
  })
  .strict()
  .superRefine(requireUniqueSortedSessions);
export const CardAgentSessionsResponseSchema = z
  .object({
    card_id: cardIdSchema,
    sessions: z.array(AgentSessionSummarySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireUniqueSortedSessions({ sessions: value.sessions }, ctx);
    for (const [index, session] of value.sessions.entries())
      if (session.card_id !== value.card_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', index, 'card_id'],
          message: 'Session must belong to the requested card.',
        });
  });
export const AgentSessionDetailSchema = AgentSessionSummarySchema;
export const AgentDetailResponseSchema = z
  .object({
    session: AgentSessionDetailSchema,
  })
  .strict();
export const AgentConversationResponseSchema = z
  .object({
    session_id: ConversationSessionIdSchema,
    entries: z.array(AgentConversationEntrySchema),
    cursor: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, entry] of value.entries.entries())
      if (entry.session_id !== value.session_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'session_id'],
          message: 'Conversation entry session must match the enclosing session.',
        });
  });
export const AgentLlmExchangeResponseSchema = z
  .object({
    sessionId: ConversationSessionIdSchema,
    exchange: providerExchangePayloadSchema,
  })
  .strict();

export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;
export type AgentSessionDetail = z.infer<typeof AgentSessionDetailSchema>;
export type AgentConversationEntry = z.infer<typeof AgentConversationEntrySchema>;
export type CardAgentSessionsResponse = z.infer<typeof CardAgentSessionsResponseSchema>;
export type AgentDetailResponse = z.infer<typeof AgentDetailResponseSchema>;
export type AgentConversationResponse = z.infer<typeof AgentConversationResponseSchema>;
export type AgentLlmExchangeResponse = z.infer<typeof AgentLlmExchangeResponseSchema>;

export const agentOperatorApiContracts = {
  'agents.list': {
    operationId: 'agents.list',
    method: 'GET',
    path: '/api/agents',
    success: AgentListResponseSchema,
    error: ApiErrorSchema,
    response: {
      200: AgentListResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      403: ForbiddenErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
    successSchemaName: 'AgentListResponse',
  },
  'agents.detail': {
    operationId: 'agents.detail',
    method: 'GET',
    path: '/api/agents/:id',
    params: AgentSessionParamsSchema,
    success: AgentDetailResponseSchema,
    error: ApiErrorSchema,
    response: {
      200: AgentDetailResponseSchema,
      400: ApiErrorSchema,
      401: UnauthorizedErrorSchema,
      403: ForbiddenErrorSchema,
      404: ApiErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'AgentDetailResponse',
  },
  'agents.cardSessions': {
    operationId: 'agents.cardSessions',
    method: 'GET',
    path: '/api/cards/:id/agent-sessions',
    params: CardAgentSessionsParamsSchema,
    success: CardAgentSessionsResponseSchema,
    error: ApiErrorSchema,
    response: {
      200: CardAgentSessionsResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      403: ForbiddenErrorSchema,
      404: ApiErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardAgentSessionsResponse',
  },
  'agents.conversation': {
    operationId: 'agents.conversation',
    method: 'GET',
    path: '/api/agents/:id/conversation',
    params: AgentConversationParamsSchema,
    query: AgentConversationQuerySchema,
    success: AgentConversationResponseSchema,
    error: ApiErrorSchema,
    response: {
      200: AgentConversationResponseSchema,
      400: ApiErrorSchema,
      401: UnauthorizedErrorSchema,
      403: ForbiddenErrorSchema,
      404: ApiErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'AgentConversationResponse',
  },
  'agents.llmExchange': {
    operationId: 'agents.llmExchange',
    method: 'GET',
    path: '/api/agents/:id/llm-exchange',
    params: AgentLlmExchangeParamsSchema,
    success: AgentLlmExchangeResponseSchema,
    error: ApiErrorSchema,
    response: {
      200: AgentLlmExchangeResponseSchema,
      400: ApiErrorSchema,
      401: UnauthorizedErrorSchema,
      403: ForbiddenErrorSchema,
      404: ApiErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'AgentLlmExchangeResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;

function requireUniqueSortedSessions(
  value: { sessions: readonly z.infer<typeof AgentSessionSummarySchema>[] },
  ctx: z.RefinementCtx,
): void {
  const ids = value.sessions.map((session) => session.id);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessions'],
      message: 'Session ids must be unique.',
    });
  if (ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) > 0))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessions'],
      message: 'Sessions must be sorted by id.',
    });
}
