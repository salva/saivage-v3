import { z } from 'zod';
import { providerExchangePayloadSchema } from './provider-exchange.js';
import { agentMessageSchema, AnalystConversationSessionIdSchema, ConversationSessionIdSchema, PlannerConversationSessionIdSchema, ReviewerConversationSessionIdSchema, ExecutorConversationSessionIdSchema } from '../schemas/index.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const AgentSessionParamsSchema = z.object({ id: ConversationSessionIdSchema });
export const AgentConversationParamsSchema = AgentSessionParamsSchema;
export const AgentLlmExchangeParamsSchema = AgentSessionParamsSchema;
const sessionFields = { status: z.enum(['active', 'waiting', 'inactive']), started_at: z.string().datetime(), model: z.string().optional() };
export const AnalystSessionSummarySchema = z.object({ id: AnalystConversationSessionIdSchema, role: z.literal('analyst'), goal_card_id: z.null().optional(), card_id: z.null().optional(), ...sessionFields }).strict();
const plannerSessionSchema = z.object({ id: PlannerConversationSessionIdSchema, role: z.literal('planner'), goal_card_id: z.string().nullable().optional(), card_id: z.string().nullable().optional(), ...sessionFields }).strict();
const reviewerSessionSchema = z.object({ id: ReviewerConversationSessionIdSchema, role: z.literal('reviewer'), goal_card_id: z.string().nullable().optional(), card_id: z.string().nullable().optional(), ...sessionFields }).strict();
const executorSessionSchema = z.object({ id: ExecutorConversationSessionIdSchema, role: z.literal('executor'), goal_card_id: z.string().nullable().optional(), card_id: z.string().nullable().optional(), ...sessionFields }).strict();
function requireMatchingCard(value: { id: string; role: string; card_id?: string | null }, ctx: z.RefinementCtx): void {
  if (value.role === 'analyst') return;
  const cardId = value.id.slice(value.id.indexOf(':') + 1);
  if (value.card_id !== cardId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['card_id'], message: 'Agent card ownership must match its session identity.' });
}
const agentSessionSummaryUnion = z.discriminatedUnion('role', [AnalystSessionSummarySchema, plannerSessionSchema, reviewerSessionSchema, executorSessionSchema]);
export const AgentSessionSummarySchema = agentSessionSummaryUnion.superRefine(requireMatchingCard);
export const AgentConversationEntrySchema = agentMessageSchema;
export const AgentActivityStatusSchema = z.object({
  status: z.enum(['active', 'waiting', 'inactive']),
  pending_calls: z.array(z.object({ id: z.string().min(1), tool: z.string().min(1), started_at: z.string().datetime() }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'waiting' && value.pending_calls.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_calls'], message: 'Waiting activity requires exactly one pending call.' });
  if (value.status !== 'waiting' && value.pending_calls.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_calls'], message: 'Only waiting activity may have a pending call.' });
});
export const AgentListResponseSchema = z.object({
  sessions: z.array(AgentSessionSummarySchema),
}).strict();
const detailFields = { message_count: z.number().int().nonnegative(), last_activity_at: z.string().nullable() };
export const AgentSessionDetailSchema = z.discriminatedUnion('role', [AnalystSessionSummarySchema.extend(detailFields), plannerSessionSchema.extend(detailFields), reviewerSessionSchema.extend(detailFields), executorSessionSchema.extend(detailFields)]).superRefine(requireMatchingCard);
export const AgentDetailResponseSchema = z.object({
  session: AgentSessionDetailSchema,
}).strict();
export const AgentConversationResponseSchema = z.object({
  session: AgentSessionSummarySchema,
  entries: z.array(AgentConversationEntrySchema),
  activity_status: AgentActivityStatusSchema,
}).strict().superRefine((value, ctx) => { if (value.session.status !== value.activity_status.status) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activity_status', 'status'], message: 'Session and activity status must match.' }); for (const [index, entry] of value.entries.entries()) if (entry.session_id !== value.session.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'session_id'], message: 'Conversation entry session must match the enclosing session.' }); });
export const AgentLlmExchangeResponseSchema = z.object({
  sessionId: ConversationSessionIdSchema,
  exchange: providerExchangePayloadSchema,
});


export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;
export type AgentSessionDetail = z.infer<typeof AgentSessionDetailSchema>;
export type AgentConversationEntry = z.infer<typeof AgentConversationEntrySchema>;
export type AgentActivityStatus = z.infer<typeof AgentActivityStatusSchema>;
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
    response: { 200: AgentListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
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
    response: { 200: AgentDetailResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'AgentDetailResponse',
  },
  'agents.conversation': {
    operationId: 'agents.conversation',
    method: 'GET',
    path: '/api/agents/:id/conversation',
    params: AgentConversationParamsSchema,
    success: AgentConversationResponseSchema,
    error: ApiErrorSchema,
    response: { 200: AgentConversationResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: UnexpectedInternalServerErrorSchema },
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
    response: { 200: AgentLlmExchangeResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'AgentLlmExchangeResponse',
  }
} as const satisfies Record<string, OperatorRouteContract>;
