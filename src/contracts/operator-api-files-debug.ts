import { z } from 'zod';
import { agentNameSchema, cardTypeSchema, errorEventSchema, recordNameSchema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { CurrentStateUnavailableSchema } from './operator-api-agents.js';

export const WorkspaceFilesQuerySchema = z.object({ path: z.string().optional() }).strict();
export const WorkspaceFileContentQuerySchema = z.object({ path: z.string().optional() }).strict();
export const WorkspaceFilesListResponseSchema = z.object({
  path: z.string(),
  files: z.array(z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(['directory', 'file']),
    size: z.number().int().nonnegative().optional(),
    modifiedAt: z.string(),
  }).strict()),
}).strict();
export const WorkspaceFileContentResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  content: z.string(),
  redacted: z.boolean(),
  sensitivity: z.string(),
  version: z.number().int().positive().optional(),
  modifiedAt: z.string().nullable().optional(),
}).strict();

export const WorkspaceFileErrorSchema = z.object({ error: z.string() }).strict();
export const WorkspaceFilePathErrorSchema = z.object({ error: z.string(), path: z.string() }).strict();
export const WorkspaceFileTooLargeErrorSchema = z.object({
  error: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  maxSize: z.number().int().positive(),
}).strict();
const HistoricalVersionNotListedSchema = z.object({ error: z.literal('historical_version_not_found'), resource: z.enum(['card', 'authored_record', 'conversation']), owner_id: z.string().min(1), version: z.number().int().positive() }).strict();
const HistoricalVersionUnavailableSchema = z.object({ error: z.literal('historical_version_content_unavailable'), resource: z.enum(['card', 'authored_record', 'conversation']), owner_id: z.string().min(1), version: z.number().int().positive(), reason: z.enum(['missing', 'corrupt', 'io_error']) }).strict();
export const WorkspaceHistoricalVersionNotFoundSchema = z.object({ error: z.literal('workspace_historical_version_not_found'), path: z.string(), historical: HistoricalVersionNotListedSchema }).strict();
export const WorkspaceHistoricalVersionUnavailableSchema = z.object({ error: z.literal('workspace_historical_version_unavailable'), path: z.string(), historical: HistoricalVersionUnavailableSchema }).strict();
export const WorkspaceCurrentStateUnavailableSchema = z.object({ error: z.literal('workspace_current_state_unavailable'), path: z.string(), current: CurrentStateUnavailableSchema }).strict();
export const WorkspaceFilesListBadRequestSchema = z.union([ValidationErrorSchema, WorkspaceFilePathErrorSchema]);
export const WorkspaceFileContentBadRequestSchema = z.union([ValidationErrorSchema, WorkspaceFileErrorSchema, WorkspaceFilePathErrorSchema]);
export const WorkspaceFileContentForbiddenSchema = z.union([WorkspaceFileErrorSchema, WorkspaceFilePathErrorSchema]);

export const DebugErrorsResponseSchema = z.object({ errors: z.array(errorEventSchema), total: z.number().int().nonnegative() }).strict()
  .refine((response) => response.total === response.errors.length, { path: ['total'], message: 'total must equal errors.length' });

const DebugGraphRecordSchema = z.object({
  name: recordNameSchema,
  format: z.literal('markdown'),
  schema: z.string().min(1),
  bootstrap: z.boolean(),
}).strict();
const DebugGraphEntrySchema = z.object({
  entry: z.enum(['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED']),
  node_id: z.string().min(1),
  prompt_reference: z.string().min(1).nullable(),
}).strict();
const DebugGraphPromotionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }).strict(),
  z.object({ kind: z.literal('latest-node'), node_id: z.string().min(1) }).strict(),
]);
const DebugGraphEdgeSchema = z.object({
  source_node_id: z.string().min(1),
  outcome: z.string().min(1),
  runtime_owned: z.boolean(),
  prompt_reference: z.string().min(1).nullable(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('node'), node_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('terminal'), terminal: z.enum(['DONE', 'BLOCKED', 'FAILED']) }).strict(),
  ]),
  export_records: z.array(recordNameSchema),
  promotion: DebugGraphPromotionSchema.nullable(),
}).strict();
const DebugGraphNodeSchema = z.object({
  node_id: z.string().min(1),
  agent_name: agentNameSchema,
  session: z.object({ scope: z.literal('card'), identity_pattern: z.string().min(1) }).strict(),
  prompt: z.object({
    source: z.enum(['override-card', 'override-shared', 'bundled-card', 'bundled-shared']),
    reference: z.string().min(1),
    process_reference: z.string().min(1),
    correction_reference: z.string().min(1),
  }).strict(),
  model: z.object({
    route: z.string().min(1),
    candidates: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()),
    temperature: z.number(),
    max_tokens: z.number().int().positive(),
  }).strict(),
  skills: z.boolean(),
  tools: z.array(z.string().min(1)),
  child_creation_types: z.array(cardTypeSchema),
  child_activation_types: z.array(cardTypeSchema),
  readable_records: z.array(recordNameSchema),
  record_write_patterns: z.array(z.string().min(1)),
  requirements: z.array(z.object({ record_name: recordNameSchema, mode:z.enum(['clean','continue']),gate:z.enum(['exists','updated']) }).strict()),
  descendant_context: z.object({ records: z.array(recordNameSchema), require_unchanged_until_accept: z.boolean() }).strict().nullable(),
  outcomes: z.array(z.string().min(1)),
}).strict();
export const DebugGraphSchema = z.object({
  card_type: cardTypeSchema,
  permitted_child_types: z.array(cardTypeSchema),
  records: z.array(DebugGraphRecordSchema),
  entries: z.array(DebugGraphEntrySchema).length(4),
  nodes: z.array(DebugGraphNodeSchema).min(1),
  edges: z.array(DebugGraphEdgeSchema).min(1),
  terminals: z.array(z.object({ terminal: z.enum(['DONE', 'BLOCKED', 'FAILED']) }).strict()).length(3),
}).strict();
export const DebugGraphsResponseSchema = z.object({ graphs: z.array(DebugGraphSchema) }).strict();

const DoctorCardsLoadableOkCheckSchema = z.object({
  name: z.literal('cards_loadable'),
  passed: z.literal(true),
  details: z.literal('Cards loaded successfully.'),
}).strict();
const DoctorCardsLoadableFailedCheckSchema = z.object({
  name: z.literal('cards_loadable'),
  passed: z.literal(false),
  details: z.literal('Cards failed to load.'),
}).strict();
const DoctorCardsLoadFailedIssueSchema = z.object({
  severity: z.literal('error'),
  message: z.literal('Cards failed to load.'),
}).strict();
export const DoctorResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    checks: z.tuple([DoctorCardsLoadableOkCheckSchema]),
    issues: z.tuple([]),
  }).strict(),
  z.object({
    status: z.literal('issues_found'),
    checks: z.tuple([DoctorCardsLoadableFailedCheckSchema]),
    issues: z.tuple([DoctorCardsLoadFailedIssueSchema]),
  }).strict(),
]);

export type WorkspaceFilesListResponse = z.infer<typeof WorkspaceFilesListResponseSchema>;
export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponseSchema>;
export type DebugErrorsResponse = z.infer<typeof DebugErrorsResponseSchema>;
export type DebugGraph = z.infer<typeof DebugGraphSchema>;
export type DebugGraphsResponse = z.infer<typeof DebugGraphsResponseSchema>;
export type DoctorResponse = z.infer<typeof DoctorResponseSchema>;

export const filesDebugOperatorApiContracts = {
  'files.list': {
    operationId: 'files.list',
    method: 'GET',
    path: '/api/files',
    query: WorkspaceFilesQuerySchema,
    success: WorkspaceFilesListResponseSchema,
    error: z.union([WorkspaceFilesListBadRequestSchema, WorkspaceFileErrorSchema, WorkspaceFilePathErrorSchema]),
    response: { 200: WorkspaceFilesListResponseSchema, 400: WorkspaceFilesListBadRequestSchema, 401: UnauthorizedErrorSchema, 403: WorkspaceFileErrorSchema, 404: WorkspaceFilePathErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'WorkspaceFilesListResponse',
  },
  'files.content': {
    operationId: 'files.content',
    method: 'GET',
    path: '/api/files/content',
    query: WorkspaceFileContentQuerySchema,
    success: WorkspaceFileContentResponseSchema,
    error: z.union([WorkspaceFileContentBadRequestSchema, WorkspaceFileContentForbiddenSchema, WorkspaceFilePathErrorSchema, WorkspaceFileTooLargeErrorSchema, WorkspaceHistoricalVersionNotFoundSchema, WorkspaceHistoricalVersionUnavailableSchema, WorkspaceCurrentStateUnavailableSchema]),
    response: { 200: WorkspaceFileContentResponseSchema, 400: WorkspaceFileContentBadRequestSchema, 401: UnauthorizedErrorSchema, 403: WorkspaceFileContentForbiddenSchema, 404: z.union([WorkspaceFilePathErrorSchema, WorkspaceHistoricalVersionNotFoundSchema, WorkspaceHistoricalVersionUnavailableSchema]), 409: WorkspaceHistoricalVersionUnavailableSchema, 413: WorkspaceFileTooLargeErrorSchema, 415: WorkspaceFilePathErrorSchema, 500: UnexpectedInternalServerErrorSchema, 503: z.union([WorkspaceCurrentStateUnavailableSchema, WorkspaceHistoricalVersionUnavailableSchema]) },
    ...operatorSessionContract,
    successSchemaName: 'WorkspaceFileContentResponse',
  },
  'debug.errors': {
    operationId: 'debug.errors',
    method: 'GET',
    path: '/api/debug/errors',
    success: DebugErrorsResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: DebugErrorsResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DebugErrorsResponse',
  },
  'debug.graphs': {
    operationId: 'debug.graphs',
    method: 'GET',
    path: '/api/debug/graphs',
    success: DebugGraphsResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: DebugGraphsResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DebugGraphsResponse',
  },
  'debug.doctor': {
    operationId: 'debug.doctor',
    method: 'GET',
    path: '/api/debug/doctor',
    success: DoctorResponseSchema,
    error: UnauthorizedErrorSchema,
    response: { 200: DoctorResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DoctorResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
