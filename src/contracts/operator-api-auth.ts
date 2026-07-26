import { z } from 'zod';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const WebSocketTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.string(),
}).strict();

export type WebSocketTicketResponse = z.infer<typeof WebSocketTicketResponseSchema>;

export const authOperatorApiContracts = {
  'auth.wsTicket': {
    operationId: 'auth.wsTicket',
    method: 'POST',
    path: '/api/auth/ws-ticket',
    success: WebSocketTicketResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: WebSocketTicketResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'WebSocketTicketResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
