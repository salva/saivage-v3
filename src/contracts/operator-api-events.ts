import { z } from 'zod';
import { loggedEventSchema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const EventsQuerySchema = z.object({
  kind: z.string().optional(),
  session_id: z.string().optional(),
  goal_id: z.string().optional(),
  limit: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  offset: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
});

export const EventsListResponseSchema = z.object({
  events: z.array(loggedEventSchema),
  total: z.number().int().nonnegative(),
});

export const EventsListFailureSchema = z.object({
  error: z.literal('Failed to query events'),
  message: z.string(),
});

export type EventsQuery = z.infer<typeof EventsQuerySchema>;
export type EventsListResponse = z.infer<typeof EventsListResponseSchema>;
export type EventsListFailure = z.infer<typeof EventsListFailureSchema>;

export const eventsOperatorApiContracts = {
  'events.list': {
    operationId: 'events.list',
    method: 'GET',
    path: '/api/events',
    query: EventsQuerySchema,
    success: EventsListResponseSchema,
    error: EventsListFailureSchema,
    response: { 200: EventsListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: EventsListFailureSchema },
    ...operatorSessionContract,
    successSchemaName: 'EventsListResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
