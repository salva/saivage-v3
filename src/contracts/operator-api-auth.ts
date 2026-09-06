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

export const authOperatorApiContracts = {
  'auth.wsTicket': {
    operationId: 'auth.wsTicket',
    method: 'POST',
    path: '/api/auth/ws-ticket',
    success: WebSocketTicketResponseSchema,
    response: { 200: WebSocketTicketResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
