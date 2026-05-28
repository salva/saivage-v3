import { z } from 'zod';
import { controlActionAuditEntrySchema } from '../schemas/index.js';
import {
  publicContract,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const ConfigGetResponseSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
});

export const ConfigUnavailableErrorSchema = z.object({
  error: z.literal('Configuration unavailable'),
  message: z.string(),
});

export const ProviderSummarySchema = z.object({
  priority: z.number().optional(),
  models: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
  hasAccounts: z.number().int().nonnegative(),
  status: z.literal('unknown'),
});

export const ProvidersListResponseSchema = z.object({
  providers: z.record(z.string(), ProviderSummarySchema),
});

export const ProvidersUnavailableErrorSchema = z.object({
  error: z.literal('Providers unavailable'),
  message: z.string(),
});

export const ControlActionsQuerySchema = z.object({
  card_id: z.string().optional(),
  since: z.string().optional(),
});

export const ControlActionsListResponseSchema = z.object({
  control_actions: z.array(controlActionAuditEntrySchema),
  total: z.number().int().nonnegative(),
});

export const ControlActionsListFailureSchema = z.object({
  error: z.literal('Failed to list control actions'),
  message: z.string(),
});

export type ConfigGetResponse = z.infer<typeof ConfigGetResponseSchema>;
export type ConfigUnavailableError = z.infer<typeof ConfigUnavailableErrorSchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ProvidersListResponse = z.infer<typeof ProvidersListResponseSchema>;
export type ProvidersUnavailableError = z.infer<typeof ProvidersUnavailableErrorSchema>;
export type ControlActionsQuery = z.infer<typeof ControlActionsQuerySchema>;
export type ControlActionsListResponse = z.infer<typeof ControlActionsListResponseSchema>;
export type ControlActionsListFailure = z.infer<typeof ControlActionsListFailureSchema>;

export const configOperatorApiContracts = {
  'config.get': {
    operationId: 'config.get',
    method: 'GET',
    path: '/api/config',
    success: ConfigGetResponseSchema,
    error: ConfigUnavailableErrorSchema,
    response: { 200: ConfigGetResponseSchema, 500: ConfigUnavailableErrorSchema },
    ...publicContract,
    successSchemaName: 'ConfigGetResponse',
  },
  'providers.list': {
    operationId: 'providers.list',
    method: 'GET',
    path: '/api/providers',
    success: ProvidersListResponseSchema,
    error: ProvidersUnavailableErrorSchema,
    response: { 200: ProvidersListResponseSchema, 500: ProvidersUnavailableErrorSchema },
    ...publicContract,
    successSchemaName: 'ProvidersListResponse',
  },
  'controlActions.list': {
    operationId: 'controlActions.list',
    method: 'GET',
    path: '/api/control-actions',
    query: ControlActionsQuerySchema,
    success: ControlActionsListResponseSchema,
    error: ControlActionsListFailureSchema,
    response: { 200: ControlActionsListResponseSchema, 400: ValidationErrorSchema, 500: ControlActionsListFailureSchema },
    ...publicContract,
    successSchemaName: 'ControlActionsListResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
