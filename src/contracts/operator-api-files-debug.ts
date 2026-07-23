import { z } from 'zod';
import { agentNameSchema, cardTypeSchema, errorEventSchema, recordNameSchema } from '../schemas/index.js';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const WorkspaceFilesQuerySchema = z.object({ path: z.string().optional() });
export const WorkspaceFileContentQuerySchema = z.object({ path: z.string().optional() });
export const WorkspaceFilesListResponseSchema = z.object({
  path: z.string(),
  files: z.array(z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(['directory', 'file']),
    size: z.number().int().nonnegative().optional(),
    modifiedAt: z.string(),
  })),
});
export const WorkspaceFileContentResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  content: z.string(),
  redacted: z.boolean(),
  sensitivity: z.string(),
  version: z.number().int().positive().optional(),
  modifiedAt: z.string().nullable().optional(),
});

export const DebugErrorsResponseSchema = z.object({ errors: z.array(errorEventSchema), total: z.number().int().nonnegative() }).strict()
  .refine((response) => response.total === response.errors.length, { path: ['total'], message: 'total must equal errors.length' });

const DebugGraphRecordSchema = z.object({
  name: recordNameSchema,
  format: z.literal('markdown'),
  schema: z.string().min(1),
  writers: z.array(agentNameSchema),
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
    source: z.enum(['card-specific', 'generic-override', 'bundled']),
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
  writable_records: z.array(recordNameSchema),
  requirements: z.array(z.object({ record_name: recordNameSchema, kind: z.enum(['present', 'updated']) }).strict()),
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

export type WorkspaceFilesListResponse = z.infer<typeof WorkspaceFilesListResponseSchema>;
export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponseSchema>;
export type DebugErrorsResponse = z.infer<typeof DebugErrorsResponseSchema>;
export type DebugGraph = z.infer<typeof DebugGraphSchema>;
export type DebugGraphsResponse = z.infer<typeof DebugGraphsResponseSchema>;

export const filesDebugOperatorApiContracts = {
  'files.list': {
    operationId: 'files.list',
    method: 'GET',
    path: '/api/files',
    query: WorkspaceFilesQuerySchema,
    success: WorkspaceFilesListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: WorkspaceFilesListResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'WorkspaceFilesListResponse',
  },
  'files.content': {
    operationId: 'files.content',
    method: 'GET',
    path: '/api/files/content',
    query: WorkspaceFileContentQuerySchema,
    success: WorkspaceFileContentResponseSchema,
    error: ApiErrorSchema,
    response: { 200: WorkspaceFileContentResponseSchema, 400: ApiErrorSchema, 401: UnauthorizedErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema, 413: ApiErrorSchema, 415: ApiErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'WorkspaceFileContentResponse',
  },
  'debug.errors': {
    operationId: 'debug.errors',
    method: 'GET',
    path: '/api/debug/errors',
    success: DebugErrorsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: DebugErrorsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DebugErrorsResponse',
  },
  'debug.graphs': {
    operationId: 'debug.graphs',
    method: 'GET',
    path: '/api/debug/graphs',
    success: DebugGraphsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: DebugGraphsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DebugGraphsResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
