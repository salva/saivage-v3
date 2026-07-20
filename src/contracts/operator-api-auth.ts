import { z } from 'zod';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const WebSocketTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.string(),
});

export type WebSocketTicketResponse = z.infer<typeof WebSocketTicketResponseSchema>;

export const authOperatorApiContracts = {
  'auth.wsTicket': {
    operationId: 'auth.wsTicket',
    method: 'POST',
    path: '/api/auth/ws-ticket',
    success: WebSocketTicketResponseSchema,
    error: ApiErrorSchema,
    response: { 200: WebSocketTicketResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'WebSocketTicketResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
