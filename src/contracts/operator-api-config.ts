import { z } from 'zod';
import {
  cardIdSchema,
  controlActionAuditEntrySchema,
  outboundEffectiveSaivageConfigSchema,
} from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
export const ConfigGetResponseSchema = z.object({
  config: outboundEffectiveSaivageConfigSchema,
  warnings: z.array(z.string()),
}).strict();

const EffectiveProviderCapabilitiesSchema = z.object({
  transportProtocol: z.enum(['openai-chat-completions', 'openai-codex-backend', 'openai-responses']),
  toolsMode: z.enum(['native', 'unsupported']),
  exclusiveToolChoiceSupport: z.enum(['native', 'parallel_off', 'unsupported']),
  responsesReasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).optional() }).strict().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  quirks: z.array(z.string()),
}).strict();

const ProviderCandidateSchema = z.object({
  provider: z.string(),
  account: z.string().nullable(),
  model: z.string(),
}).strict();

const HealthyProviderAvailabilitySchema = z.object({
  candidate: ProviderCandidateSchema,
  state: z.literal('HEALTHY'),
  reason: z.string().optional(),
}).strict();

const UnavailableProviderAvailabilitySchema = (state: 'BLOCKED_UNTIL' | 'COOLING') => z.object({
  candidate: ProviderCandidateSchema,
  state: z.literal(state),
  untilMs: z.number().finite().positive(),
  reason: z.string().optional(),
}).strict();

const ProviderAvailabilitySchema = z.discriminatedUnion('state', [
  HealthyProviderAvailabilitySchema,
  UnavailableProviderAvailabilitySchema('BLOCKED_UNTIL'),
  UnavailableProviderAvailabilitySchema('COOLING'),
]);

export const ProviderSummarySchema = z.object({
  priority: z.number().int(),
  models: z.array(z.string()),
  candidateCount: z.number().int().nonnegative(),
  availableCandidateCount: z.number().int().nonnegative(),
  capabilitiesByModel: z.record(z.string(), EffectiveProviderCapabilitiesSchema),
  availability: z.array(ProviderAvailabilitySchema),
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
    response: { 200: ConfigGetResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'providers.list': {
    operationId: 'providers.list',
    method: 'GET',
    path: '/api/providers',
    success: ProvidersListResponseSchema,
    response: { 200: ProvidersListResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'controlActions.list': {
    operationId: 'controlActions.list',
    method: 'GET',
    path: '/api/control-actions',
    query: ControlActionsQuerySchema,
    success: ControlActionsListResponseSchema,
    response: { 200: ControlActionsListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
