import { z } from 'zod';
import {
  ApiErrorSchema,
  ContractViolationErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const ChatSessionParamsSchema = z.object({ sessionId: z.string().min(1) });
export const ChatWorkspaceContextSchema = z.object({
  view: z.string().nullable(),
  entityId: z.string().nullable(),
  refinement: z.record(z.string(), z.string()).nullable(),
});
export const ChatSendRequestSchema = z.object({
  content: z.string().optional(),
  workspaceContext: z.unknown().optional(),
});
export const ChatListResponseSchema = z.object({
  sessions: z.array(z.object({
    id: z.string(),
    role: z.string(),
    status: z.string(),
    started_at: z.string(),
  }).catchall(z.unknown())),
});
export const ChatEntriesResponseSchema = z.object({
  sessionId: z.string(),
  entries: z.array(z.unknown()),
});
export const ChatSendResponseSchema = z.object({
  sessionId: z.string(),
  message: z.object({
    id: z.string(),
    role: z.literal('assistant'),
    kind: z.literal('text'),
    content: z.string(),
    timestamp: z.string(),
  }).catchall(z.unknown()),
  toolInvocations: z.array(z.unknown()),
});

export type ChatListResponse = z.infer<typeof ChatListResponseSchema>;
export type ChatEntriesResponse = z.infer<typeof ChatEntriesResponseSchema>;
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

export const chatOperatorApiContracts = {
  'chats.list': {
    operationId: 'chats.list',
    method: 'GET',
    path: '/api/chats',
    success: ChatListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ChatListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: ChatEntriesResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: ChatSendResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ContractViolationErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ChatSendResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
