import { z } from 'zod';
import {
  cardRecordSchema,
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

export type ContractAuthClass = 'public' | 'operator-session' | 'agent-session' | 'mcp-tool-token';

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  statusCode: z.number().int().optional(),
}).catchall(z.unknown());

export const ValidationErrorSchema = ApiErrorSchema.extend({
  error: z.union([z.literal('ValidationError'), z.literal('Request validation failed')]),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const UnauthorizedErrorSchema = ApiErrorSchema.extend({
  error: z.literal('Unauthorized'),
  statusCode: z.literal(401).optional(),
});

export const ForbiddenErrorSchema = ApiErrorSchema.extend({
  error: z.literal('Forbidden'),
  statusCode: z.literal(403).optional(),
});

export const ContractViolationErrorSchema = ApiErrorSchema.extend({
  error: z.literal('ContractViolation'),
});

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
export const PlannerStateCardFieldsSchema = z.object({
  planner_state: cardStatusSchema.optional(),
  plannerState: cardStatusSchema.optional(),
});

export const CardIdParamsSchema = z.object({ id: z.string().min(1) });

export const CardIndexSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byType: z.record(z.string(), z.number().int().nonnegative()),
});



export const AvailabilityStateSchema = z.enum(['available', 'degraded', 'idle', 'unavailable', 'unknown']);
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
export const HealthLivenessResponseSchema = z.object({ status: z.literal('ok'), version: z.string(), project: z.string() });
export const HealthReadinessResponseSchema = z.object({ status: z.enum(['ready', 'not_ready']), serverAvailability: ServerAvailabilitySchema.optional() });

export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;
export type AvailabilityComponent = z.infer<typeof AvailabilityComponentSchema>;
export type ServerAvailability = z.infer<typeof ServerAvailabilitySchema>;

export const RuntimeGetStateResponseSchema = z.object({
  projectRoot: z.string().min(1),
  projectId: z.string().min(1),
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
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
  response?: Record<number, z.ZodTypeAny>;
  auth?: ContractAuthClass;
  permissions?: (context: { contract: OperatorRouteContract; params: unknown; query: unknown; body: unknown; request: unknown }) => boolean | { allowed: true } | { allowed: false; reason?: string } | Promise<boolean | { allowed: true } | { allowed: false; reason?: string }>;
  audit?: { kind: string; action?: string; targetKind?: string | null; targetId?: (context: { request: unknown; body: unknown }) => string | null };
  describe?: string;
  requiresAuth: boolean;
  successSchemaName: string;
};

const publicContract = { auth: 'public', requiresAuth: false } as const;
const operatorSessionContract = { auth: 'operator-session', requiresAuth: true } as const;

export const operatorApiContracts = {
  'health.liveness': {
    operationId: 'health.liveness',
    method: 'GET',
    path: '/health',
    success: HealthLivenessResponseSchema,
    error: ApiErrorSchema,
    response: { 200: HealthLivenessResponseSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: HealthReadinessResponseSchema, 503: HealthReadinessResponseSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: RuntimeGetStateResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ContractViolationErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeGetStateResponse',
  },
  'cards.list': {
    operationId: 'cards.list',
    method: 'GET',
    path: '/api/cards',
    success: CardListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: CardListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: CardDetailResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: CardHistoryListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: CardHistoryEntryResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: ContractViolationErrorSchema },
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
    response: { 200: CardDiffResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: ApiErrorSchema, 500: ContractViolationErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'CardDiffResponse',
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
