import { z } from 'zod';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { ConversationSessionIdSchema } from '../schemas/index.js';
import { ToolInvocationResultSchema } from './tool-invocation-projection.js';

export const ChatWorkspaceContextSchema = z.object({
  view: z.string().nullable(),
  entityId: z.string().nullable(),
  refinement: z.record(z.string(), z.string()).nullable(),
}).strict();
export const ChatSendRequestSchema = z.object({
  content: z.string().min(1),
  workspaceContext: ChatWorkspaceContextSchema.optional(),
}).strict();
export const ChatIdentityResponseSchema = z
  .object({
    session_id: ConversationSessionIdSchema,
  })
  .strict();
export const RestartChatAcknowledgementSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('confirmation_required'),
      confirmationMessage: z.literal('RESTART SERVER'),
    })
    .strict(),
  z.object({ status: z.literal('scheduled') }).strict(),
]);
export const ChatToolInvocationSchema = z
  .object({
    tool: z.string().min(1),
    params: z.unknown(),
    result: ToolInvocationResultSchema,
  })
  .strict();
export const ChatSendResponseSchema = z
  .object({
    toolInvocations: z.array(ChatToolInvocationSchema),
    restart: RestartChatAcknowledgementSchema.nullable(),
  })
  .strict();

export type ChatWorkspaceContext = z.infer<typeof ChatWorkspaceContextSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;
export type ChatIdentityResponse = z.infer<typeof ChatIdentityResponseSchema>;
export type RestartChatAcknowledgement = z.infer<typeof RestartChatAcknowledgementSchema>;
export type ChatToolInvocation = z.infer<typeof ChatToolInvocationSchema>;
export type ChatSendResponse = z.infer<typeof ChatSendResponseSchema>;

export const chatOperatorApiContracts = {
  'chats.get': {
    operationId: 'chats.get',
    method: 'GET',
    path: '/api/chat',
    success: ChatIdentityResponseSchema,
    error: UnauthorizedErrorSchema,
    response: {
      200: ChatIdentityResponseSchema,
      401: UnauthorizedErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
    successSchemaName: 'ChatIdentityResponse',
  },
  'chats.send': {
    operationId: 'chats.send',
    method: 'POST',
    path: '/api/chat',
    body: ChatSendRequestSchema,
    success: ChatSendResponseSchema,
    error: ValidationErrorSchema,
    response: {
      200: ChatSendResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
    successSchemaName: 'ChatSendResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
