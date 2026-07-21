import { z } from 'zod';
import { eventKindValues, loggedEventSchema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const EventsQuerySchema = z.object({
  kind: z.enum(eventKindValues).optional(),
  goal_id: z.string().optional(),
  card_id: z.string().optional(),
  selection: z.enum(['oldest_page', 'newest_tail']).optional(),
  limit: z.string().regex(/^[1-9][0-9]*$/).transform(Number).refine((value) => Number.isSafeInteger(value) && value <= 1000).optional(),
  offset: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).refine(Number.isSafeInteger).optional(),
}).strict().refine((query) => query.selection !== 'newest_tail' || (query.offset ?? 0) === 0, { path: ['offset'], message: 'newest_tail forbids nonzero offset' });

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
    response: { 200: EventsListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'EventsListResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
