import { z } from 'zod';
import {
  cardRecordSchema,
  cardStatusSchema,
  cardActionSchema,
  cardTypeSchema,
  createdBySchema,
  runtimeStateSchema,
  runtimeIntentSchema,
  runtimeCommandRecordSchema,
  runtimeRunRecordSchema,
  runtimeActivationRecordSchema,
  actionableErrorEnvelopeSchema,
  urgencySchema,
} from '../schemas/validators.js';

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
}).catchall(z.unknown());

export const CardNotFoundErrorSchema = ApiErrorSchema.extend({
  cardId: z.string().optional(),
});

export const ActionableErrorEnvelopeSchema = actionableErrorEnvelopeSchema;

export const RuntimeControlErrorSchema = ApiErrorSchema.extend({
  action: z.string().optional(),
  actionable_error: ActionableErrorEnvelopeSchema.optional(),
});

export const RuntimeControlRequestSchema = z.object({}).strict().optional();

export const RuntimeCommandResponseSchema = z.object({
  success: z.literal(true),
  command: runtimeCommandRecordSchema,
  intent: runtimeIntentSchema,
  run: runtimeRunRecordSchema.optional(),
});

export const RuntimeCommandErrorResponseSchema = z.object({
  success: z.literal(false),
  command: runtimeCommandRecordSchema.optional(),
  actionable_error: ActionableErrorEnvelopeSchema,
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
export const PlannerStateCardFieldsSchema = z.object({
  planner_state: cardStatusSchema.optional(),
  plannerState: cardStatusSchema.optional(),
});

export const EmptyBodySchema = z.object({}).passthrough().optional();
export const CardIdParamsSchema = z.object({ id: z.string().min(1) });

export const CardIndexSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byType: z.record(z.string(), z.number().int().nonnegative()),
});

export const CardStoreHealthSchema = z.object({
  canonical: z.enum(['ok', 'invalid']),
});



export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'unavailable', 'unknown']);
export const AvailabilityComponentSourceSchema = z.enum(['startup', 'active-runtime', 'runtime-state', 'mcp-manager', 'health-check', 'unknown']);
export const AvailabilityDiagnosticSchema = z.object({
  code: z.string().min(1),
  summary: z.string().min(1).max(240),
});
export const AvailabilityComponentSchema = z.object({
  state: AvailabilityStateSchema,
  source: AvailabilityComponentSourceSchema,
  checkedAt: z.string().datetime(),
  diagnostic: AvailabilityDiagnosticSchema.optional(),
});
export const ServerAvailabilitySchema = z.object({
  generatedAt: z.string().datetime(),
  components: z.object({
    api: AvailabilityComponentSchema,
    runtime: AvailabilityComponentSchema,
    mcp: AvailabilityComponentSchema,
  }),
});
export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;
export type AvailabilityComponent = z.infer<typeof AvailabilityComponentSchema>;
export type ServerAvailability = z.infer<typeof ServerAvailabilitySchema>;

export const RuntimeGetStateResponseSchema = z.object({
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
  cardStoreHealth: CardStoreHealthSchema.optional(),
  serverAvailability: ServerAvailabilitySchema.optional(),
});

export const CardListResponseSchema = z.object({
  cards: z.array(cardRecordSchema),
  total: z.number().int().nonnegative(),
});

export const CardDetailResponseSchema = z.object({
  card: cardRecordSchema,
  children: z.array(cardRecordSchema),
  ancestorIds: z.array(z.string()),
});

export const CardMutationResponseSchema = z.object({
  card: cardRecordSchema,
});

const cardCreateBaseSchema = z.object({
  type: cardTypeSchema.optional(),
  parent: z.string().nullable().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: cardStatusSchema.optional(),
  planner_state: cardStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  urgency: urgencySchema.optional(),
  created_by: createdBySchema.optional(),
  depends_on: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  acceptance: z.string().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).nullable().optional(),
  estimate: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  retries: z.number().int().nonnegative().optional(),
  subtype: z.string().nullable().optional(),
  assigned_to: z.string().nullable().optional(),
  instructions_file: z.string().nullable().optional(),
});

export const CardCreateBodySchema = cardCreateBaseSchema.strip();

export const CardUpdateBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: cardStatusSchema.optional(),
  planner_state: cardStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  urgency: urgencySchema.optional(),
  acceptance: z.string().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).nullable().optional(),
  depends_on: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  estimate: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  retries: z.number().int().nonnegative().optional(),
  parent: z.string().nullable().optional(),
  assigned_to: z.string().nullable().optional(),
  type: cardTypeSchema.optional(),
  subtype: z.string().nullable().optional(),
  instructions_file: z.string().nullable().optional(),
}).strip();

export type OperatorRouteContract<
  TParams extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TQuery extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TBody extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TSuccess extends z.ZodTypeAny = z.ZodTypeAny,
  TError extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  operationId: string;
  method: HttpMethod;
  path: string;
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  success: TSuccess;
  error: TError;
  requiresAuth: boolean;
  successSchemaName: string;
};

export const operatorApiContracts = {
  'runtime.getState': {
    operationId: 'runtime.getState',
    method: 'GET',
    path: '/api/state',
    success: RuntimeGetStateResponseSchema,
    error: ApiErrorSchema,
    requiresAuth: true,
    successSchemaName: 'RuntimeGetStateResponse',
  },
  'runtime.startProject': {
    operationId: 'runtime.startProject',
    method: 'POST',
    path: '/api/runtime/start_project',
    body: RuntimeControlRequestSchema,
    success: RuntimeCommandResponseSchema,
    error: RuntimeCommandErrorResponseSchema,
    requiresAuth: true,
    successSchemaName: 'RuntimeCommandResponse',
  },
  'runtime.stopProject': {
    operationId: 'runtime.stopProject',
    method: 'POST',
    path: '/api/runtime/stop_project',
    body: RuntimeControlRequestSchema,
    success: RuntimeCommandResponseSchema,
    error: RuntimeCommandErrorResponseSchema,
    requiresAuth: true,
    successSchemaName: 'RuntimeCommandResponse',
  },
  'runtime.pause': {
    operationId: 'runtime.pause',
    method: 'POST',
    path: '/api/runtime/pause',
    body: EmptyBodySchema,
    success: runtimeStateSchema,
    error: RuntimeControlErrorSchema,
    requiresAuth: true,
    successSchemaName: 'RuntimeState',
  },
  'runtime.resume': {
    operationId: 'runtime.resume',
    method: 'POST',
    path: '/api/runtime/resume',
    body: EmptyBodySchema,
    success: runtimeStateSchema,
    error: RuntimeControlErrorSchema,
    requiresAuth: true,
    successSchemaName: 'RuntimeState',
  },
  'cards.list': {
    operationId: 'cards.list',
    method: 'GET',
    path: '/api/cards',
    success: CardListResponseSchema,
    error: ApiErrorSchema,
    requiresAuth: true,
    successSchemaName: 'CardListResponse',
  },
  'cards.get': {
    operationId: 'cards.get',
    method: 'GET',
    path: '/api/cards/:id',
    params: CardIdParamsSchema,
    success: CardDetailResponseSchema,
    error: CardNotFoundErrorSchema,
    requiresAuth: true,
    successSchemaName: 'CardDetailResponse',
  },
  'cards.create': {
    operationId: 'cards.create',
    method: 'POST',
    path: '/api/cards',
    body: CardCreateBodySchema,
    success: CardMutationResponseSchema,
    error: ApiErrorSchema,
    requiresAuth: true,
    successSchemaName: 'CardMutationResponse',
  },
  'cards.update': {
    operationId: 'cards.update',
    method: 'PATCH',
    path: '/api/cards/:id',
    params: CardIdParamsSchema,
    body: CardUpdateBodySchema,
    success: CardMutationResponseSchema,
    error: CardNotFoundErrorSchema,
    requiresAuth: true,
    successSchemaName: 'CardMutationResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;

export type OperatorApiOperationId = keyof typeof operatorApiContracts;
export type OperatorApiContract<K extends OperatorApiOperationId> = (typeof operatorApiContracts)[K];
export type OperatorApiSuccess<K extends OperatorApiOperationId> = z.infer<OperatorApiContract<K>['success']>;
export type OperatorApiBody<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { body: infer TBody extends z.ZodTypeAny } ? z.infer<TBody> : undefined;
export type OperatorApiParams<K extends OperatorApiOperationId> = OperatorApiContract<K> extends { params: infer TParams extends z.ZodTypeAny } ? z.infer<TParams> : undefined;

export function parseOperatorResponse<K extends OperatorApiOperationId>(operationId: K, payload: unknown): OperatorApiSuccess<K> {
  return operatorApiContracts[operationId].success.parse(payload) as OperatorApiSuccess<K>;
}

export function safeParseOperatorResponse<K extends OperatorApiOperationId>(operationId: K, payload: unknown) {
  return operatorApiContracts[operationId].success.safeParse(payload);
}

export function operatorRouteInventory(): Array<{
  operationId: OperatorApiOperationId;
  method: HttpMethod;
  path: string;
  requiresAuth: boolean;
  successSchemaName: string;
}> {
  return Object.values(operatorApiContracts).map((contract) => ({
    operationId: contract.operationId as OperatorApiOperationId,
    method: contract.method,
    path: contract.path,
    requiresAuth: contract.requiresAuth,
    successSchemaName: contract.successSchemaName,
  }));
}
