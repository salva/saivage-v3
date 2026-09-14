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
import { HistoricalVersionNotFoundSchema } from './historical-version-not-found.js';

const WorkspaceFilesQuerySchema = z.object({ path: z.string().optional() }).strict();
const WorkspaceFileContentQuerySchema = z.object({ path: z.string().optional() }).strict();
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
const WorkspaceFileContentResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  content: z.string(),
  redacted: z.boolean(),
  sensitivity: z.string(),
  version: z.number().int().positive().optional(),
  modifiedAt: z.string().nullable().optional(),
}).strict();

const WorkspaceFileErrorSchema = z.object({ error: z.string() }).strict();
const WorkspaceFilePathErrorSchema = z.object({ error: z.string(), path: z.string() }).strict();
const WorkspaceFileTooLargeErrorSchema = z.object({
  error: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  maxSize: z.number().int().positive(),
}).strict();
export const WorkspaceHistoricalVersionNotFoundSchema = z.object({ error: z.literal('workspace_historical_version_not_found'), path: z.string(), historical: HistoricalVersionNotFoundSchema }).strict();
const WorkspaceCurrentStateUnavailableSchema = z.object({ error: z.literal('workspace_current_state_unavailable'), path: z.string(), current: CurrentStateUnavailableSchema }).strict();
const WorkspaceFilesListBadRequestSchema = z.union([ValidationErrorSchema, WorkspaceFilePathErrorSchema]);
const WorkspaceFileContentBadRequestSchema = z.union([ValidationErrorSchema, WorkspaceFileErrorSchema, WorkspaceFilePathErrorSchema]);
const WorkspaceFileContentForbiddenSchema = z.union([WorkspaceFileErrorSchema, WorkspaceFilePathErrorSchema]);

const DebugErrorsResponseSchema = z.object({ errors: z.array(errorEventSchema), total: z.number().int().nonnegative() }).strict()
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
  condition: z.enum(['default', 'pending_notifications']),
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
const DebugGraphSchema = z.object({
  card_type: cardTypeSchema,
  notification_recipient: agentNameSchema,
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
export type DebugGraphsResponse = z.infer<typeof DebugGraphsResponseSchema>;
export const filesDebugOperatorApiContracts = {
  'files.list': {
    operationId: 'files.list',
    method: 'GET',
    path: '/api/files',
    query: WorkspaceFilesQuerySchema,
    success: WorkspaceFilesListResponseSchema,
    response: { 200: WorkspaceFilesListResponseSchema, 400: WorkspaceFilesListBadRequestSchema, 401: UnauthorizedErrorSchema, 403: WorkspaceFileErrorSchema, 404: WorkspaceFilePathErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'files.content': {
    operationId: 'files.content',
    method: 'GET',
    path: '/api/files/content',
    query: WorkspaceFileContentQuerySchema,
    success: WorkspaceFileContentResponseSchema,
    response: { 200: WorkspaceFileContentResponseSchema, 400: WorkspaceFileContentBadRequestSchema, 401: UnauthorizedErrorSchema, 403: WorkspaceFileContentForbiddenSchema, 404: z.union([WorkspaceFilePathErrorSchema, WorkspaceHistoricalVersionNotFoundSchema]), 413: WorkspaceFileTooLargeErrorSchema, 415: WorkspaceFilePathErrorSchema, 500: UnexpectedInternalServerErrorSchema, 503: WorkspaceCurrentStateUnavailableSchema },
    ...operatorSessionContract,
  },
  'debug.errors': {
    operationId: 'debug.errors',
    method: 'GET',
    path: '/api/debug/errors',
    success: DebugErrorsResponseSchema,
    response: { 200: DebugErrorsResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'debug.graphs': {
    operationId: 'debug.graphs',
    method: 'GET',
    path: '/api/debug/graphs',
    success: DebugGraphsResponseSchema,
    response: { 200: DebugGraphsResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
  'debug.doctor': {
    operationId: 'debug.doctor',
    method: 'GET',
    path: '/api/debug/doctor',
    success: DoctorResponseSchema,
    response: { 200: DoctorResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
