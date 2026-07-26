import { z } from 'zod';
import { cardIdSchema } from '../schemas/index.js';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { effectiveSaivageConfigSchema } from '../schemas/saivage-config.js';

export const ConfigGetResponseSchema = z.object({
  config: effectiveSaivageConfigSchema,
  warnings: z.array(z.string()),
}).strict();

export const ProviderSummarySchema = z.object({
  priority: z.number(),
  models: z.array(z.string()),
  baseUrl: z.string().optional(),
  candidateCount: z.number().int().nonnegative(),
  availableCandidateCount: z.number().int().nonnegative(),
  capabilitiesByModel: z.record(z.string(), z.unknown()),
  availability: z.array(z.object({
    candidate: z.object({ provider: z.string(), account: z.string().nullable(), model: z.string() }).strict(),
    state: z.string(),
    reason: z.string().optional(),
    untilMs: z.number().optional(),
  }).strict()),
}).strict();

export const ProvidersListResponseSchema = z.object({
  availabilityScope: z.literal('process_local_reset_on_restart'),
  providers: z.record(z.string(), ProviderSummarySchema),
}).strict();

export const ControlActionsQuerySchema = z.object({
  card_id: cardIdSchema.optional(),
  since: z.string().optional(),
}).strict();

export const ControlActionsListResponseSchema = z.object({
  control_actions: z.array(controlActionAuditEntrySchema),
  total: z.number().int().nonnegative(),
}).strict();

export type ConfigGetResponse = z.infer<typeof ConfigGetResponseSchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ProvidersListResponse = z.infer<typeof ProvidersListResponseSchema>;
export type ControlActionsQuery = z.infer<typeof ControlActionsQuerySchema>;
export type ControlActionsListResponse = z.infer<typeof ControlActionsListResponseSchema>;

export const configOperatorApiContracts = {
  'config.get': {
    operationId: 'config.get',
    method: 'GET',
    path: '/api/config',
    success: ConfigGetResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: ConfigGetResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ConfigGetResponse',
  },
  'providers.list': {
    operationId: 'providers.list',
    method: 'GET',
    path: '/api/providers',
    success: ProvidersListResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: ProvidersListResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ProvidersListResponse',
  },
  'controlActions.list': {
    operationId: 'controlActions.list',
    method: 'GET',
    path: '/api/control-actions',
    query: ControlActionsQuerySchema,
    success: ControlActionsListResponseSchema,
    error: ValidationErrorSchema,
    response: { 200: ControlActionsListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ControlActionsListResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
