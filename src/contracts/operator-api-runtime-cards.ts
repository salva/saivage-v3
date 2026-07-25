import { z } from 'zod';
import {
  cardHistoryEntrySchema,
  cardHistoryHeaderSchema,
  runtimeStateSchema,
  cardIdSchema,
  cardTypeSchema,
  agentNameSchema,
  recordNameSchema,
  positiveSafeIntegerSchema,
  cardStatusSchema,
  urgencySchema,
  cardActionSchema,
  cardLifecycleStateSchema,
} from '../schemas/index.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  publicContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { ServerAvailabilitySchema } from './operator-api-availability.js';
import { actorPauseModeSchema, publicCardActorStateSchema } from '../schemas/actor-vocabulary.js';
import { runtimeStatusSchema } from '../schemas/index.js';

export const CardNotFoundErrorSchema = z.object({ error: z.literal('Card not found'), cardId: cardIdSchema }).strict();
export const CardRecordDefinitionNotFoundErrorSchema = z.object({ error: z.literal('Card record definition not found'), cardId: cardIdSchema, name: recordNameSchema }).strict();
export const CardRecordNotFoundErrorSchema = z.object({ error: z.literal('Card record not found'), cardId: cardIdSchema, name: recordNameSchema }).strict();
export const CardHistoryEntryNotFoundErrorSchema = z.object({ error: z.literal('Card history entry not found'), cardId: cardIdSchema, version_seq: positiveSafeIntegerSchema }).strict();
export const CardDiffSourceNotFoundErrorSchema = z.object({ error: z.literal('Card diff source not found'), cardId: cardIdSchema, from: positiveSafeIntegerSchema, to: positiveSafeIntegerSchema, missing_version_seq: positiveSafeIntegerSchema }).strict();
export const CardHistoryEntryNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, CardHistoryEntryNotFoundErrorSchema]);
export const CardDiffNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, CardDiffSourceNotFoundErrorSchema]);

export const CardIdParamsSchema = z.object({ id: cardIdSchema }).strict();
export const CardRecordNameParamsSchema = z.object({ id: cardIdSchema, name: recordNameSchema }).strict();

export const HealthLivenessResponseSchema = z.object({ status: z.literal('ok'), version: z.string(), project: z.string() });
export const HealthReadinessResponseSchema = z.object({ status: z.enum(['ready', 'not_ready']), serverAvailability: ServerAvailabilitySchema.optional() });


export const RuntimeGetStateResponseSchema = z.object({
  projectRoot: z.string().min(1),
  projectId: z.string().min(1),
  runtime: runtimeStateSchema.nullable(),
  serverAvailability: ServerAvailabilitySchema.optional(),
}).strict();

const refineHierarchyIdentity = (value: { id: string; type: string }, ctx: z.RefinementCtx): void => {
  if (value.id === 'project' && value.type !== 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'The project card is the fixed root.' });
  if (value.id !== 'project' && value.type === 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Only the fixed project card may have type project.' });
};
const hierarchyShape = { id: cardIdSchema, title: z.string().min(1), type: cardTypeSchema, status: cardStatusSchema };
export const CardHierarchyParentSchema = z.object(hierarchyShape).strict().superRefine(refineHierarchyIdentity);
export const CardHierarchyChildSummarySchema = z.object(hierarchyShape).strict().superRefine(refineHierarchyIdentity);
export const CardChildrenResponseSchema = z.object({ parent: CardHierarchyParentSchema, children: z.array(CardHierarchyChildSummarySchema) }).strict().superRefine((value, ctx) => {
  if (new Set(value.children.map(({ id }) => id)).size !== value.children.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['children'], message: 'Direct child ids must be unique.' });
});
export const CardDetailLifecycleSchema = cardLifecycleStateSchema;
export const CardDetailSchema = z.object({
  id: cardIdSchema,
  title: z.string().min(1),
  type: cardTypeSchema,
  lifecycle: CardDetailLifecycleSchema,
  version_seq: positiveSafeIntegerSchema,
  urgency: urgencySchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  allowedActions: z.array(cardActionSchema),
}).strict().superRefine(refineHierarchyIdentity);
export const CardDetailResponseSchema = z.object({ card: CardDetailSchema }).strict();
export const CardRecordDescriptorSchema = z.object({ name: recordNameSchema, format: z.literal('markdown'), schema: z.string().min(1), writers: z.array(agentNameSchema), bootstrap: z.boolean() }).strict().superRefine((value, ctx) => {
  if (new Set(value.writers).size !== value.writers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['writers'], message: 'Record writers must be unique.' });
});
export const CardRecordListResponseSchema = z.object({ card_id: cardIdSchema, records: z.array(CardRecordDescriptorSchema) }).strict().superRefine((value, ctx) => {
  if (new Set(value.records.map(({ name }) => name)).size !== value.records.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'Record names must be unique.' });
  if (value.records.filter(({ bootstrap }) => bootstrap).length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'Exactly one record must be bootstrap.' });
});
export const CardRecordContentSchema = z.object({ name: recordNameSchema, version: positiveSafeIntegerSchema, committed_at: z.string().datetime(), content: z.string() }).strict();
export const CardRecordContentResponseSchema = z.object({ card_id: cardIdSchema, record: CardRecordContentSchema }).strict();

export const CardHistoryParamsSchema = z.object({ id: cardIdSchema });
export const canonicalPositiveSafeIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/).superRefine((raw, ctx) => {
  if (!positiveSafeIntegerSchema.safeParse(Number(raw)).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a canonical positive safe integer.' });
}).transform(Number);
export const CardHistoryEntryParamsSchema = z.object({ id: cardIdSchema, seq: canonicalPositiveSafeIntegerStringSchema });
const diffPivotSchema = z.union([
  z.literal('last'),
  z.literal('current'),
  canonicalPositiveSafeIntegerStringSchema,
]);
export const CardDiffQuerySchema = z.object({ from: diffPivotSchema.optional(), to: diffPivotSchema.optional() });
export const CardHistoryListResponseSchema = z.object({ history: z.array(cardHistoryHeaderSchema), total: z.number().int().nonnegative() });
export const CardHistoryEntryResponseSchema = z.object({ entry: cardHistoryEntrySchema });
export const CardDiffResponseSchema = z.object({ diff: z.unknown(), from: positiveSafeIntegerSchema, to: positiveSafeIntegerSchema, card_id: cardIdSchema }).strict();
export const InvalidCardDiffPivotsErrorSchema = z.object({ error: z.literal('Invalid diff pivots'), from: positiveSafeIntegerSchema, to: positiveSafeIntegerSchema }).strict();
export const CardDiffBadRequestSchema = z.union([ValidationErrorSchema, InvalidCardDiffPivotsErrorSchema]);


export const RuntimeStatusResponseSchema = z.object({
  runtime: runtimeStatusSchema,
  currentCardId: cardIdSchema.nullable(),
  started_at: z.string().datetime(),
  restart_server_available: z.boolean(),
  pid: z.number().int().positive(),
  actorRuntime: z.object({
    pauseMode: actorPauseModeSchema,
    cards: z.array(z.object({
      cardId: cardIdSchema,
      actorState: publicCardActorStateSchema,
      processState: z.discriminatedUnion('kind', [
        z.object({ cardType: cardTypeSchema, stateId: z.string().min(1), kind: z.literal('ready') }).strict(),
        z.object({ cardType: cardTypeSchema, stateId: z.string().min(1), kind: z.literal('entry'), entry: z.enum(['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED']) }).strict(),
        z.object({ cardType: cardTypeSchema, stateId: z.string().min(1), kind: z.literal('node'), nodeId: z.string().min(1), executionOrdinal: z.number().int().nonnegative().safe() }).strict(),
        z.object({ cardType: cardTypeSchema, stateId: z.string().min(1), kind: z.literal('terminal'), terminal: z.enum(['DONE', 'BLOCKED', 'FAILED']) }).strict(),
      ]).nullable(),
    }).strict()),
  }).strict(),
  serverAvailability: ServerAvailabilitySchema.optional(),
}).strict();

export const StopProjectResponseSchema = z.object({ status: z.literal('stopped'), contained: z.boolean() }).strict();
export const RestartServerRequestSchema = z.object({ confirmation: z.literal('RESTART SERVER') }).strict();
export const RestartServerResponseSchema = z.object({ status: z.literal('restart_scheduled') }).strict();
export const RestartUnavailableErrorSchema = z.object({ code: z.literal('restart_unavailable'), message: z.literal('restart unavailable: operator authentication disabled') }).strict();

export const RuntimeCardRunsResponseSchema = z.object({
  current_card_id: cardIdSchema.nullable(),
  active_breadcrumb: z.array(z.object({
    card_id: cardIdSchema,
    card_type: z.string(),
    title: z.string(),
    status_text: z.string().optional(),
  }).strict()),
  dormant_agents: z.array(z.object({
    card_id: cardIdSchema,
    agent_name:z.string().min(1),
    session_id: z.string(),
  }).strict()),
}).strict();

export type HealthLivenessResponse = z.infer<typeof HealthLivenessResponseSchema>;
export type HealthReadinessResponse = z.infer<typeof HealthReadinessResponseSchema>;
export type RuntimeGetStateResponse = z.infer<typeof RuntimeGetStateResponseSchema>;
export type CardHierarchyParent = z.infer<typeof CardHierarchyParentSchema>;
export type CardHierarchyChildSummary = z.infer<typeof CardHierarchyChildSummarySchema>;
export type CardDetail = z.infer<typeof CardDetailSchema>;
export type CardChildrenResponse = z.infer<typeof CardChildrenResponseSchema>;
export type CardDetailResponse = z.infer<typeof CardDetailResponseSchema>;
export type CardRecordDescriptor = z.infer<typeof CardRecordDescriptorSchema>;
export type CardRecordListResponse = z.infer<typeof CardRecordListResponseSchema>;
export type CardRecordContent = z.infer<typeof CardRecordContentSchema>;
export type CardRecordContentResponse = z.infer<typeof CardRecordContentResponseSchema>;
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
    response: { 200: HealthLivenessResponseSchema, 500: UnexpectedInternalServerErrorSchema },
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
    response: { 200: HealthReadinessResponseSchema, 503: HealthReadinessResponseSchema, 500: UnexpectedInternalServerErrorSchema },
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
    response: { 200: RuntimeGetStateResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeGetStateResponse',
  },
  'cards.children': {
    operationId: 'cards.children',
    method: 'GET',
    path: '/api/cards/:id/children',
    params: CardIdParamsSchema,
    success: CardChildrenResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardChildrenResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardChildrenResponse',
  },
  'cards.get': {
    operationId: 'cards.get',
    method: 'GET',
    path: '/api/cards/:id',
    params: CardIdParamsSchema,
    success: CardDetailResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardDetailResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardDetailResponse',
  },
  'cards.records.list': {
    operationId: 'cards.records.list',
    method: 'GET',
    path: '/api/cards/:id/records',
    params: CardIdParamsSchema,
    success: CardRecordListResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardRecordListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardRecordListResponse',
  },
  'cards.records.get': {
    operationId: 'cards.records.get',
    method: 'GET',
    path: '/api/cards/:id/records/:name',
    params: CardRecordNameParamsSchema,
    success: CardRecordContentResponseSchema,
    error: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema, CardRecordNotFoundErrorSchema]),
    response: { 200: CardRecordContentResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema, CardRecordNotFoundErrorSchema]), 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardRecordContentResponse',
  },

  'cards.history.list': {
    operationId: 'cards.history.list',
    method: 'GET',
    path: '/api/cards/:id/history',
    params: CardHistoryParamsSchema,
    success: CardHistoryListResponseSchema,
    error: CardNotFoundErrorSchema,
    response: { 200: CardHistoryListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardHistoryListResponse',
  },
  'cards.history.get': {
    operationId: 'cards.history.get',
    method: 'GET',
    path: '/api/cards/:id/history/:seq',
    params: CardHistoryEntryParamsSchema,
    success: CardHistoryEntryResponseSchema,
    error: CardHistoryEntryNotFoundUnionSchema,
    response: { 200: CardHistoryEntryResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardHistoryEntryNotFoundUnionSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
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
    error: CardDiffNotFoundUnionSchema,
    response: { 200: CardDiffResponseSchema, 400: CardDiffBadRequestSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 404: CardDiffNotFoundUnionSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
    successSchemaName: 'CardDiffResponse',
  },
  'runtime.status': {
    operationId: 'runtime.status',
    method: 'GET',
    path: '/api/runtime/status',
    success: RuntimeStatusResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeStatusResponse',
  },
  'runtime.pause': {
    operationId: 'runtime.pause',
    method: 'POST',
    path: '/api/runtime/pause',
    success: RuntimeStatusResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeStatusResponse',
  },
  'runtime.resume': {
    operationId: 'runtime.resume',
    method: 'POST',
    path: '/api/runtime/resume',
    success: RuntimeStatusResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeStatusResponse',
  },
  stop_project: {
    operationId: 'stop_project',
    method: 'POST',
    path: '/api/runtime/stop-project',
    success: StopProjectResponseSchema,
    error: ApiErrorSchema,
    response: { 200: StopProjectResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'StopProjectResponse',
  },
  restart_server: {
    operationId: 'restart_server',
    method: 'POST',
    path: '/api/runtime/restart-server',
    body: RestartServerRequestSchema,
    success: RestartServerResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RestartServerResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: RestartUnavailableErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RestartServerResponse',
  },
  'runtime.cardRuns': {
    operationId: 'runtime.cardRuns',
    method: 'GET',
    path: '/api/runtime/card-runs',
    success: RuntimeCardRunsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: RuntimeCardRunsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'RuntimeCardRunsResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
