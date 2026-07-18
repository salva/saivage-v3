import { z } from 'zod';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { AgentActivityStatusSchema, AgentConversationEntrySchema, AnalystSessionSummarySchema } from './operator-api-agents.js';
import { AnalystConversationSessionIdSchema } from '../schemas/index.js';

export const ChatSessionParamsSchema = z.object({ sessionId: AnalystConversationSessionIdSchema });
export const ChatWorkspaceContextSchema = z.object({
  view: z.string().nullable(),
  entityId: z.string().nullable(),
  refinement: z.record(z.string(), z.string()).nullable(),
});
export const ChatSendRequestSchema = z.object({
  content: z.string().optional(),
  workspaceContext: ChatWorkspaceContextSchema.optional(),
});
export const ChatListResponseSchema = z.object({
  sessions: z.array(AnalystSessionSummarySchema),
}).strict();
export const ChatEntriesResponseSchema = z.object({
  session: AnalystSessionSummarySchema.nullable(),
  entries: z.array(AgentConversationEntrySchema),
  activity_status: AgentActivityStatusSchema,
}).strict().superRefine((value, ctx) => {
  if (value.session === null) {
    if (value.entries.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: 'Absent chat session requires empty entries.' });
    if (value.activity_status.status !== 'inactive' || value.activity_status.pending_calls.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activity_status'], message: 'Absent chat session requires inactive activity.' });
    return;
  }
  if (value.session.status !== value.activity_status.status) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activity_status', 'status'], message: 'Session and activity status must match.' });
  for (const [index, entry] of value.entries.entries()) if (entry.session_id !== value.session.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'session_id'], message: 'Chat entry session must match the enclosing session.' });
});
export const RestartChatAcknowledgementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('confirmation_required'), confirmationMessage: z.literal('RESTART SERVER') }).strict(),
  z.object({ status: z.literal('scheduled') }).strict(),
]);
export const ChatSendResponseSchema = z.object({
  sessionId: AnalystConversationSessionIdSchema,
  toolInvocations: z.array(z.unknown()),
  restart: RestartChatAcknowledgementSchema.nullable(),
}).strict();

export type ChatListResponse = z.infer<typeof ChatListResponseSchema>;
export type ChatSession = z.infer<typeof ChatListResponseSchema>['sessions'][number];
export type ChatWorkspaceContext = z.infer<typeof ChatWorkspaceContextSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;
export type ChatEntriesResponse = z.infer<typeof ChatEntriesResponseSchema>;
export type RestartChatAcknowledgement = z.infer<typeof RestartChatAcknowledgementSchema>;
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

export const chatOperatorApiContracts = {
  'chats.list': {
    operationId: 'chats.list',
    method: 'GET',
    path: '/api/chats',
    success: ChatListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ChatListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ChatListResponse',
  },
  'chats.get': {
    operationId: 'chats.get',
    method: 'GET',
    path: '/api/chats/:sessionId',
    params: ChatSessionParamsSchema,
    success: ChatEntriesResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ChatEntriesResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ChatEntriesResponse',
  },
  'chats.send': {
    operationId: 'chats.send',
    method: 'POST',
    path: '/api/chats/:sessionId',
    params: ChatSessionParamsSchema,
    body: ChatSendRequestSchema,
    success: ChatSendResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ChatSendResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ChatSendResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
