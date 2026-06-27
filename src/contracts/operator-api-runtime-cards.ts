import { z } from 'zod';
import {
  cardViewSchema,
  cardRefViewSchema,
  cardStatusSchema,
  cardActionSchema,
  cardHistoryEntrySchema,
  cardHistoryHeaderSchema,
  runtimeStateSchema,
  runtimeIntentSchema,
  runtimeCommandRecordSchema,
  runtimeRunRecordSchema,
  runtimeActivationRecordSchema,
} from '../schemas/index.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  publicContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { ServerAvailabilitySchema } from './operator-api-availability.js';
import { actorPauseModeSchema, publicAgentPhaseSchema, publicCardActorStateSchema, llmActorRoleSchema } from '../runtime/actors/actor-vocabulary.js';
import { runtimeStatusSchema } from '../schemas/index.js';

export const CardNotFoundErrorSchema = ApiErrorSchema.extend({
  cardId: z.string().optional(),
});

export const RuntimeSummarySchema = z.object({
  intent: runtimeIntentSchema,
  currentRun: runtimeRunRecordSchema.nullable(),
  activeChildRuns: z.array(runtimeRunRecordSchema),
  activations: z.array(runtimeActivationRecordSchema),
  lastCommand: runtimeCommandRecordSchema.nullable(),
});

export const RuntimeRunRecordSchema = runtimeRunRecordSchema;
export const RuntimeActivationRecordSchema = runtimeActivationRecordSchema;
export const RuntimeCommandRecordSchema = runtimeCommandRecordSchema;
export const CardPermissionFieldsSchema = z.object({ allowedActions: z.array(cardActionSchema).optional() });

export const CardIdParamsSchema = z.object({ id: z.string().min(1) });

export const CardIndexSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byType: z.record(z.string(), z.number().int().nonnegative()),
});



export const HealthLivenessResponseSchema = z.object({ status: z.literal('ok'), version: z.string(), project: z.string() });
export const HealthReadinessResponseSchema = z.object({ status: z.enum(['ready', 'not_ready']), serverAvailability: ServerAvailabilitySchema.optional() });


export const RuntimeGetStateResponseSchema = z.object({
  projectRoot: z.string().min(1),
  projectId: z.string().min(1),
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
  serverAvailability: ServerAvailabilitySchema.optional(),
});

export const CardListResponseSchema = z.object({
  cards: z.array(cardViewSchema),
  total: z.number().int().nonnegative(),
});

export const CardDetailCardSchema = cardViewSchema.and(z.object({
  dependencyRefs: z.array(cardRefViewSchema),
  relatedRefs: z.array(cardRefViewSchema),
}));

export const CardDetailResponseSchema = z.object({
  card: CardDetailCardSchema,
  children: z.array(cardViewSchema),
  ancestorIds: z.array(z.string()),
  ancestorRefs: z.array(cardRefViewSchema),
});

export const CardHistoryParamsSchema = z.object({ id: z.string().min(1) });
export const CardHistoryEntryParamsSchema = z.object({ id: z.string().min(1), seq: z.string().min(1) });
const diffPivotSchema = z.union([
  z.literal('last'),
  z.literal('current'),
  z.string().regex(/^[1-9][0-9]*$/, 'positive integer or "last"/"current"'),
]);
export const CardDiffQuerySchema = z.object({ from: diffPivotSchema.optional(), to: diffPivotSchema.optional() });
export const CardHistoryListResponseSchema = z.object({ history: z.array(cardHistoryHeaderSchema), total: z.number().int().nonnegative() });
export const CardHistoryEntryResponseSchema = z.object({ entry: cardHistoryEntrySchema });
export const CardDiffResponseSchema = z.object({ diff: z.unknown(), from: z.number().int().positive(), to: z.number().int().positive(), card_id: z.string() });


export const RuntimeStatusResponseSchema = z.object({
  runtime: runtimeStatusSchema,
  paused: z.boolean(),
  currentCardId: z.string().nullable(),
  goalCount: z.number().int().nonnegative(),
  lastTickAt: z.string().nullable(),
  pid: z.number().int().positive(),
  actorRuntime: z.object({
    pauseMode: actorPauseModeSchema,
    activeWork: z.enum(['none', 'model_invocation', 'shutdown', 'unknown']),
    cards: z.array(z.object({ cardId: z.string(), actorState: publicCardActorStateSchema })),
    agents: z.array(z.object({ agentId: z.string(), role: llmActorRoleSchema, cardId: z.string(), phase: publicAgentPhaseSchema })),
    diagnostics: z.array(z.string()),
    recovery: z.object({
      generated_at: z.string().datetime(),
      diagnostics: z.array(z.object({
        actorId: z.string(),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string(),
      })),
      actions: z.array(z.object({
        actorId: z.string(),
        kind: z.enum(['active_card', 'active_llm', 'llm_recovery_action', 'active_processor', 'running_process', 'discarded_supervisor']),
        action: z.string(),
        cardId: z.string().optional(),
        processId: z.string().optional(),
      })),
    }).nullable(),
  }),
  serverAvailability: ServerAvailabilitySchema.optional(),
});

export const RuntimeCardRunsResponseSchema = z.object({
  active_card_run: z.unknown().nullable(),
  active_breadcrumb: z.array(z.object({
    card_id: z.string(),
    card_type: z.string(),
    title: z.string(),
    status_text: z.string().optional(),
  })),
  dormant_planners: z.array(z.object({
    goal_card_id: z.string(),
    planner_session_id: z.string(),
    latest_self_report: z.record(z.string(), z.unknown()).nullable(),
  })),
  cards_with_pending_corrections: z.array(z.object({
    card_id: z.string(),
    status: cardStatusSchema,
    note_count: z.number().int().nonnegative(),
    last_note_at: z.string().nullable(),
  })),
});

export type HealthLivenessResponse = z.infer<typeof HealthLivenessResponseSchema>;
export type HealthReadinessResponse = z.infer<typeof HealthReadinessResponseSchema>;
export type RuntimeGetStateResponse = z.infer<typeof RuntimeGetStateResponseSchema>;
export type CardListResponse = z.infer<typeof CardListResponseSchema>;
export type CardDetailResponse = z.infer<typeof CardDetailResponseSchema>;
export type CardHistoryListResponse = z.infer<typeof CardHistoryListResponseSchema>;
export type CardHistoryEntryResponse = z.infer<typeof CardHistoryEntryResponseSchema>;
export type CardDiffResponse = z.infer<typeof CardDiffResponseSchema>;
export type RuntimeStatusResponse = z.infer<typeof RuntimeStatusResponseSchema>;
export type RuntimeCardRunsResponse = z.infer<typeof RuntimeCardRunsResponseSchema>;


export const runtimeCardsOperatorApiContracts = {
  'health.liveness': {
    operationId: 'health.liveness',
    method: 'GET',
    path: '/health',
    success: HealthLivenessResponseSchema,
    error: ApiErrorSchema,
    response: { 200: HealthLivenessResponseSchema, 500: ApiErrorSchema },
    ...publicContract,
    successSchemaName: 'HealthLivenessResponse',
    describe: 'Cheap process liveness probe.',
  },
  'health.readiness': {
    operationId: 'health.readiness',
    method: 'GET',
    path: '/health/ready',
    success: HealthReadinessResponseSchema,
    error: ApiErrorSchema,
    response: { 200: HealthReadinessResponseSchema, 503: HealthReadinessResponseSchema, 500: ApiErrorSchema },
    ...publicContract,
    successSchemaName: 'HealthReadinessResponse',
    describe: 'Readiness probe for loaded environment and accepting server.',
  },
  'runtime.getState': {
    operationId: 'runtime.getState',
    method: 'GET',
    path: '/api/state',
    success: RuntimeGetStateResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeGetStateResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeGetStateResponse',
  },
  'cards.list': {
    operationId: 'cards.list',
    method: 'GET',
    path: '/api/cards',
    success: CardListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: CardListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardListResponse',
  },
  'cards.get': {
    operationId: 'cards.get',
    method: 'GET',
    path: '/api/cards/:id',
    params: CardIdParamsSchema,
    success: CardDetailResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardDetailResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardDetailResponse',
  },

  'cards.history.list': {
    operationId: 'cards.history.list',
    method: 'GET',
    path: '/api/cards/:id/history',
    params: CardHistoryParamsSchema,
    success: CardHistoryListResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardHistoryListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardHistoryListResponse',
  },
  'cards.history.get': {
    operationId: 'cards.history.get',
    method: 'GET',
    path: '/api/cards/:id/history/:seq',
    params: CardHistoryEntryParamsSchema,
    success: CardHistoryEntryResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardHistoryEntryResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardHistoryEntryResponse',
  },
  'cards.diff': {
    operationId: 'cards.diff',
    method: 'GET',
    path: '/api/cards/:id/diff',
    params: CardHistoryParamsSchema,
    query: CardDiffQuerySchema,
    success: CardDiffResponseSchema,
    error: ApiErrorSchema,
    response: { 200: CardDiffResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardDiffResponse',
  },
  'runtime.status': {
    operationId: 'runtime.status',
    method: 'GET',
    path: '/api/runtime/status',
    success: RuntimeStatusResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeStatusResponse',
  },
  'runtime.cardRuns': {
    operationId: 'runtime.cardRuns',
    method: 'GET',
    path: '/api/runtime/card-runs',
    success: RuntimeCardRunsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeCardRunsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeCardRunsResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
