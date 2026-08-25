import { z } from 'zod';
import {
  cardRecordSchema,
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
  ConversationSessionIdSchema,
  cardVersionChangeSchema,
} from '../schemas/index.js';
import {
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
export const HistoricalVersionNotFoundErrorSchema = z.object({ error: z.literal('historical_version_not_found'), resource: z.literal('card'), owner_id: cardIdSchema, version: positiveSafeIntegerSchema }).strict();
export const CardHistoryEntryNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, HistoricalVersionNotFoundErrorSchema]);
export const CardDiffNotFoundUnionSchema = z.union([CardNotFoundErrorSchema, HistoricalVersionNotFoundErrorSchema]);

export const CardIdParamsSchema = z.object({ id: cardIdSchema }).strict();
export const CardRecordNameParamsSchema = z.object({ id: cardIdSchema, name: recordNameSchema }).strict();

export const HealthLivenessResponseSchema = z.object({ status: z.literal('ok'), version: z.string(), project: z.string() }).strict();
export const HealthReadinessResponseSchema = z.object({ status: z.literal('ready'), serverAvailability: ServerAvailabilitySchema }).strict();


export const RuntimeGetStateResponseSchema = z.object({
  projectId: z.string().min(1),
  runtime: runtimeStateSchema.nullable(),
  serverAvailability: ServerAvailabilitySchema,
}).strict();

export const ContentPolicyRuntimeResponseSchema = z.object({
  refusal_high_water: z.number().int().nonnegative().safe(),
  latest: z.object({
    card_id: cardIdSchema,
    session_id: ConversationSessionIdSchema,
    marker_id: z.string().min(1),
    evidence_url: z.string().min(1),
    blocked_at: z.string().datetime(),
  }).strict().nullable(),
}).strict();

const refineHierarchyIdentity = (value: { id: string; type: string }, ctx: z.RefinementCtx): void => {
  if (value.id === 'project' && value.type !== 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'The project card is the fixed root.' });
  if (value.id !== 'project' && value.type === 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Only the fixed project card may have type project.' });
};
const hierarchyShape = { id: cardIdSchema, title: z.string().min(1), type: cardTypeSchema, status: cardStatusSchema, permitted_child_types: z.array(cardTypeSchema) };
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
const CardRecordCurrentDescriptorSchema = z.object({ head_version: positiveSafeIntegerSchema, head_entry_id: z.string().uuid(), state: z.enum(['open', 'closed', 'discarded']), accepted_source_version: positiveSafeIntegerSchema.nullable(), draft_present: z.boolean() }).strict();
export const CardRecordDescriptorSchema = z.object({ name: recordNameSchema, format: z.literal('markdown'), schema: z.string().min(1), bootstrap: z.boolean(), current: CardRecordCurrentDescriptorSchema.nullable() }).strict();
export const CardRecordListResponseSchema = z.object({ card_id: cardIdSchema, records: z.array(CardRecordDescriptorSchema) }).strict().superRefine((value, ctx) => {
  if (new Set(value.records.map(({ name }) => name)).size !== value.records.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'Record names must be unique.' });
  if (value.records.filter(({ bootstrap }) => bootstrap).length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'Exactly one record must be bootstrap.' });
});
const RecordAcceptedWireSchema = z.object({ source_version: positiveSafeIntegerSchema, source_entry_id: z.string().uuid(), committed_at: z.string().datetime(), writer_agent: z.union([agentNameSchema, z.literal('runtime:bootstrap')]), card_version_seq: positiveSafeIntegerSchema, content: z.string(), content_sha256: z.string().regex(/^[0-9a-f]{64}$/), size_bytes: z.number().int().nonnegative() }).strict();
const RecordDraftWireSchema = z.object({ opened_at: z.string().datetime(), updated_at: z.string().datetime(), content: z.string(), content_sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const CardRecordContentSchema = z.object({ name: recordNameSchema, head_version: positiveSafeIntegerSchema, head_entry_id: z.string().uuid(), state: z.enum(['open', 'closed', 'discarded']), accepted: RecordAcceptedWireSchema.nullable(), draft: RecordDraftWireSchema.nullable(), discarded: z.object({ discarded_at: z.string().datetime(), reason: z.string() }).strict().nullable(), effective_content_source: z.enum(['draft', 'accepted']).nullable() }).strict();
export const CardRecordContentResponseSchema = z.object({ card_id: cardIdSchema, record: CardRecordContentSchema }).strict();
export const canonicalPositiveSafeIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/).superRefine((raw, ctx) => {
  if (!positiveSafeIntegerSchema.safeParse(Number(raw)).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a canonical positive safe integer.' });
}).transform(Number);
const RecordHistoryVersionSchema = z.object({ entry_id: z.string().uuid(), version: positiveSafeIntegerSchema, published_at: z.string().datetime(), state: z.enum(['open', 'closed', 'discarded']), accepted_source_version: positiveSafeIntegerSchema.nullable(), draft_present: z.boolean(), discarded_at: z.string().datetime().nullable() }).strict();
export const RecordHistoryListResponseSchema = z.object({ card_id: cardIdSchema, name: recordNameSchema, versions: z.array(RecordHistoryVersionSchema), total: z.number().int().nonnegative() }).strict();
export const RecordVersionContentResponseSchema = z.object({ card_id: cardIdSchema, name: recordNameSchema, version: positiveSafeIntegerSchema, entry_id: z.string().uuid(), published_at: z.string().datetime(), artifact: z.object({ state: z.enum(['open', 'closed', 'discarded']), published_at: z.string().datetime(), accepted: RecordAcceptedWireSchema.nullable(), draft: RecordDraftWireSchema.nullable(), discarded: z.object({ discarded_at: z.string().datetime(), reason: z.string() }).strict().nullable() }).strict() }).strict();
export const RecordDiffQuerySchema = z.object({ from: canonicalPositiveSafeIntegerStringSchema, to: z.union([z.literal('current'), canonicalPositiveSafeIntegerStringSchema]).optional(), view: z.enum(['effective', 'accepted', 'draft']).optional() }).strict();
const RecordDiffHunkSchema = z.object({ old_start: z.number().int().nonnegative(), old_lines: z.number().int().nonnegative(), new_start: z.number().int().nonnegative(), new_lines: z.number().int().nonnegative(), lines: z.array(z.string()) }).strict();
export const RecordDiffResponseSchema = z.object({ card_id: cardIdSchema, name: recordNameSchema, from: positiveSafeIntegerSchema, to: positiveSafeIntegerSchema, view: z.enum(['effective', 'accepted', 'draft']), hunks: z.array(RecordDiffHunkSchema) }).strict();
export const RecordDiffViewUnavailableSchema = z.object({ error: z.literal('record_diff_view_unavailable'), card_id: cardIdSchema, name: recordNameSchema, side: z.enum(['from', 'to']), view: z.enum(['effective', 'accepted', 'draft']) }).strict();
export const RecordHistoricalVersionNotFoundSchema = z.object({ error: z.literal('historical_version_not_found'), resource: z.literal('authored_record'), owner_id: z.string().min(1), version: positiveSafeIntegerSchema }).strict();

export const CardHistoryParamsSchema = z.object({ id: cardIdSchema }).strict();
export const CardRecordVersionParamsSchema = z.object({ id: cardIdSchema, name: recordNameSchema, version: canonicalPositiveSafeIntegerStringSchema }).strict();
export const CardHistoryEntryParamsSchema = z.object({ id: cardIdSchema, version: canonicalPositiveSafeIntegerStringSchema }).strict();
const diffPivotSchema = z.union([z.literal('current'), canonicalPositiveSafeIntegerStringSchema]);
export const CardDiffQuerySchema = z.object({ from: canonicalPositiveSafeIntegerStringSchema, to: diffPivotSchema.optional() }).strict();
const cardVersionMetadataSchema = z.object({ entry_id: z.string().uuid(), version: positiveSafeIntegerSchema, published_at: z.string().datetime(), artifact_kind: z.enum(['card-version', 'card-tombstone']), change: cardVersionChangeSchema.nullable() }).strict();
export const CardHistoryListResponseSchema = z.object({ card_id: cardIdSchema, versions: z.array(cardVersionMetadataSchema), total: z.number().int().nonnegative() }).strict();
const cardVersionArtifactWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card-version'), card: cardRecordSchema, change: cardVersionChangeSchema.nullable() }).strict(),
  z.object({ kind: z.literal('card-tombstone'), final_card: cardRecordSchema, change: cardVersionChangeSchema }).strict(),
]);
export const CardHistoryEntryResponseSchema = z.object({ card_id: cardIdSchema, version: positiveSafeIntegerSchema, entry_id: z.string().uuid(), published_at: z.string().datetime(), artifact: cardVersionArtifactWireSchema }).strict();
type CardDiffJsonValue =
  | null
  | boolean
  | string
  | number
  | CardDiffJsonValue[]
  | { [key: string]: CardDiffJsonValue };

const cardDiffJsonValueSchema: z.ZodType<CardDiffJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite(),
    z.array(cardDiffJsonValueSchema),
    z.record(z.string(), cardDiffJsonValueSchema),
  ]),
);

export const CardDiffRowSchema = z.object({
  field: z.string().min(1),
  before: cardDiffJsonValueSchema,
  after: cardDiffJsonValueSchema,
}).strict();
export const CardDiffResponseSchema = z.object({ diff: z.array(CardDiffRowSchema), from: positiveSafeIntegerSchema, to: positiveSafeIntegerSchema, card_id: cardIdSchema }).strict();
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
  serverAvailability: ServerAvailabilitySchema,
}).strict();

export const StopProjectResponseSchema = z.object({ status: z.literal('stopped'), contained: z.boolean() }).strict();
export const RestartServerRequestSchema = z.object({ confirmation: z.literal('RESTART SERVER') }).strict();
export const RestartServerResponseSchema = z.object({ status: z.literal('restart_scheduled') }).strict();
export const RestartUnavailableErrorSchema = z.object({ code: z.literal('restart_unavailable'), message: z.literal('restart unavailable: operator authentication disabled') }).strict();

export type HealthLivenessResponse = z.infer<typeof HealthLivenessResponseSchema>;
export type HealthReadinessResponse = z.infer<typeof HealthReadinessResponseSchema>;
export type RuntimeGetStateResponse = z.infer<typeof RuntimeGetStateResponseSchema>;
export type ContentPolicyRuntimeResponse = z.infer<typeof ContentPolicyRuntimeResponseSchema>;
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
export type CardDiffRow = z.infer<typeof CardDiffRowSchema>;
export type CardDiffResponse = z.infer<typeof CardDiffResponseSchema>;
export type RuntimeStatusResponse = z.infer<typeof RuntimeStatusResponseSchema>;


export const runtimeCardsOperatorApiContracts = {
  'health.liveness': {
    operationId: 'health.liveness',
    method: 'GET',
    path: '/health',
    success: HealthLivenessResponseSchema,
    response: { 200: HealthLivenessResponseSchema, 500: UnexpectedInternalServerErrorSchema },
    ...publicContract,
  },
  'health.readiness': {
    operationId: 'health.readiness',
    method: 'GET',
    path: '/health/ready',
    success: HealthReadinessResponseSchema,
    response: { 200: HealthReadinessResponseSchema, 500: UnexpectedInternalServerErrorSchema },
    ...publicContract,
  },
  'runtime.getState': {
    operationId: 'runtime.getState',
    method: 'GET',
    path: '/api/state',
    success: RuntimeGetStateResponseSchema,
    response: { 200: RuntimeGetStateResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'runtime.contentPolicy': {
    operationId: 'runtime.contentPolicy',
    method: 'GET',
    path: '/api/runtime/content-policy',
    success: ContentPolicyRuntimeResponseSchema,
    response: { 200: ContentPolicyRuntimeResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'cards.children': {
    operationId: 'cards.children',
    method: 'GET',
    path: '/api/cards/:id/children',
    params: CardIdParamsSchema,
    success: CardChildrenResponseSchema,
    response: { 200: CardChildrenResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.get': {
    operationId: 'cards.get',
    method: 'GET',
    path: '/api/cards/:id',
    params: CardIdParamsSchema,
    success: CardDetailResponseSchema,
    response: { 200: CardDetailResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.records.list': {
    operationId: 'cards.records.list',
    method: 'GET',
    path: '/api/cards/:id/records',
    params: CardIdParamsSchema,
    success: CardRecordListResponseSchema,
    response: { 200: CardRecordListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.records.get': {
    operationId: 'cards.records.get',
    method: 'GET',
    path: '/api/cards/:id/records/:name',
    params: CardRecordNameParamsSchema,
    success: CardRecordContentResponseSchema,
    response: { 200: CardRecordContentResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema, CardRecordNotFoundErrorSchema]), 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.records.history.list': {
    operationId: 'cards.records.history.list', method: 'GET', path: '/api/cards/:id/records/:name/history', params: CardRecordNameParamsSchema,
    success: RecordHistoryListResponseSchema,
    response: { 200: RecordHistoryListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema]), 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' }, ...operatorSessionContract,
  },
  'cards.records.versions.get': {
    operationId: 'cards.records.versions.get', method: 'GET', path: '/api/cards/:id/records/:name/versions/:version', params: CardRecordVersionParamsSchema,
    success: RecordVersionContentResponseSchema,
    response: { 200: RecordVersionContentResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema, RecordHistoricalVersionNotFoundSchema]), 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' }, ...operatorSessionContract,
  },
  'cards.records.diff': {
    operationId: 'cards.records.diff', method: 'GET', path: '/api/cards/:id/records/:name/diff', params: CardRecordNameParamsSchema, query: RecordDiffQuerySchema,
    success: RecordDiffResponseSchema,
    response: { 200: RecordDiffResponseSchema, 400: z.union([ValidationErrorSchema, RecordDiffViewUnavailableSchema]), 401: UnauthorizedErrorSchema, 404: z.union([CardNotFoundErrorSchema, CardRecordDefinitionNotFoundErrorSchema, RecordHistoricalVersionNotFoundSchema]), 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' }, ...operatorSessionContract,
  },

  'cards.history.list': {
    operationId: 'cards.history.list',
    method: 'GET',
    path: '/api/cards/:id/history',
    params: CardHistoryParamsSchema,
    success: CardHistoryListResponseSchema,
    response: { 200: CardHistoryListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: CardNotFoundErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.history.get': {
    operationId: 'cards.history.get',
    method: 'GET',
    path: '/api/cards/:id/history/:version',
    params: CardHistoryEntryParamsSchema,
    success: CardHistoryEntryResponseSchema,
    response: { 200: CardHistoryEntryResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: CardHistoryEntryNotFoundUnionSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'cards.diff': {
    operationId: 'cards.diff',
    method: 'GET',
    path: '/api/cards/:id/diff',
    params: CardHistoryParamsSchema,
    query: CardDiffQuerySchema,
    success: CardDiffResponseSchema,
    response: { 200: CardDiffResponseSchema, 400: CardDiffBadRequestSchema, 401: UnauthorizedErrorSchema, 404: CardDiffNotFoundUnionSchema, 500: UnexpectedInternalServerErrorSchema },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'runtime.status': {
    operationId: 'runtime.status',
    method: 'GET',
    path: '/api/runtime/status',
    success: RuntimeStatusResponseSchema,
    response: { 200: RuntimeStatusResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'runtime.pause': {
    operationId: 'runtime.pause',
    method: 'POST',
    path: '/api/runtime/pause',
    success: RuntimeStatusResponseSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'runtime.resume': {
    operationId: 'runtime.resume',
    method: 'POST',
    path: '/api/runtime/resume',
    success: RuntimeStatusResponseSchema,
    response: { 200: RuntimeStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  stop_project: {
    operationId: 'stop_project',
    method: 'POST',
    path: '/api/runtime/stop-project',
    success: StopProjectResponseSchema,
    response: { 200: StopProjectResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  restart_server: {
    operationId: 'restart_server',
    method: 'POST',
    path: '/api/runtime/restart-server',
    body: RestartServerRequestSchema,
    success: RestartServerResponseSchema,
    response: { 200: RestartServerResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: RestartUnavailableErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
