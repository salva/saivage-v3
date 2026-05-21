import { z } from 'zod';
import {
  cardRecordSchema,
  cardStatusSchema,
  cardTypeSchema,
  createdBySchema,
  runtimeStateSchema,
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

export const RuntimeControlErrorSchema = ApiErrorSchema.extend({
  action: z.string().optional(),
});

export const EmptyBodySchema = z.object({}).passthrough().optional();
export const CardIdParamsSchema = z.object({ id: z.string().min(1) });

export const CardIndexSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byType: z.record(z.string(), z.number().int().nonnegative()),
});

export const CardStoreCompatibilitySnapshotWarningSchema = z.object({
  code: z.literal('compatibility-snapshot-degraded'),
  operation: z.enum(['startup-repair', 'mutation-rebuild', 'delete-cleanup', 'archive-cleanup', 'manual-repair']),
  relativePath: z.string().optional(),
  message: z.string(),
  errorName: z.string().optional(),
  occurredAt: z.string().datetime(),
  canonicalCommitted: z.boolean(),
});

export const CardStoreHealthSchema = z.object({
  canonical: z.enum(['ok', 'invalid']),
  compatibilitySnapshots: z.enum(['ok', 'degraded']),
  lastCompatibilitySnapshotWarning: CardStoreCompatibilitySnapshotWarningSchema.nullable(),
  warnings: z.array(CardStoreCompatibilitySnapshotWarningSchema),
});

export const RuntimeGetStateResponseSchema = z.object({
  runtime: runtimeStateSchema.nullable(),
  cardIndex: CardIndexSummarySchema,
  cardStoreHealth: CardStoreHealthSchema.optional(),
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
  confirmed: z.boolean().optional(),
  preview_hash: z.string().optional(),
});

export const CardCreateBodySchema = cardCreateBaseSchema.passthrough();

export const CardUpdateBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: cardStatusSchema.optional(),
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
  confirmed: z.boolean().optional(),
  preview_hash: z.string().optional(),
}).passthrough();

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
