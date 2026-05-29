import { z } from 'zod';
import { llmExchangeSchema } from './llm-exchange.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const AgentSessionParamsSchema = z.object({ id: z.string().min(1) });
export const AgentConversationParamsSchema = AgentSessionParamsSchema;
export const AgentLlmExchangeParamsSchema = AgentSessionParamsSchema;
export const AgentSessionSummarySchema = z.object({
  id: z.string(),
  role: z.string(),
  goal_card_id: z.string().nullable().optional(),
  card_id: z.string().nullable().optional(),
  status: z.string(),
  started_at: z.string(),
  completed_at: z.string().nullable().optional(),
  model: z.string().optional(),
}).catchall(z.unknown());
export const AgentConversationEntrySchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.string(),
  kind: z.string(),
  content: z.string(),
  round_id: z.string().optional(),
  message_index: z.number().int().nonnegative().optional(),
  block_index: z.number().int().nonnegative().optional(),
  tool: z.string().optional(),
  tool_call_id: z.string().optional(),
  timestamp: z.string(),
  links: z.array(z.object({
    entity_type: z.string(),
    entity_id: z.string(),
    label: z.string().optional(),
  }).catchall(z.unknown())).optional(),
  model_spec: z.string().optional(),
  requested_model_spec: z.string().optional(),
}).catchall(z.unknown());
export const AgentActivityStatusSchema = z.object({
  status: z.enum(['idle', 'thinking', 'tool_calling', 'responding', 'compacting']),
  pending_calls: z.array(z.object({ id: z.string(), tool: z.string(), started_at: z.string() }).catchall(z.unknown())),
  updated_at: z.string(),
}).catchall(z.unknown());
export const AgentListResponseSchema = z.object({
  sessions: z.array(AgentSessionSummarySchema),
});
export const AgentSessionDetailSchema = AgentSessionSummarySchema.extend({
  message_count: z.number().int().nonnegative(),
  last_activity_at: z.string().nullable(),
});
export const AgentDetailResponseSchema = z.object({
  session: AgentSessionDetailSchema,
});
export const AgentConversationResponseSchema = z.object({
  session: AgentSessionSummarySchema,
  entries: z.array(AgentConversationEntrySchema),
  activity_status: AgentActivityStatusSchema,
});
export const AgentLlmExchangeResponseSchema = z.object({
  exchange: llmExchangeSchema,
});


export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;
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
    response: { 200: AgentListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
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
    response: { 200: AgentDetailResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema },
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
    response: { 200: AgentConversationResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema },
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
    response: { 200: AgentLlmExchangeResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'AgentLlmExchangeResponse',
  }
} as const satisfies Record<string, OperatorRouteContract>;
