import { z } from 'zod';
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

export const DebugErrorsResponseSchema = z.object({ errors: z.array(z.unknown()), total: z.number().int().nonnegative() });
export const DebugTimelineResponseSchema = z.object({ events: z.array(z.unknown()), total: z.number().int().nonnegative() });

export type WorkspaceFilesListResponse = z.infer<typeof WorkspaceFilesListResponseSchema>;
export type WorkspaceFileContentResponse = z.infer<typeof WorkspaceFileContentResponseSchema>;
export type DebugErrorsResponse = z.infer<typeof DebugErrorsResponseSchema>;
export type DebugTimelineResponse = z.infer<typeof DebugTimelineResponseSchema>;

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
  'debug.timeline': {
    operationId: 'debug.timeline',
    method: 'GET',
    path: '/api/debug/timeline',
    success: DebugTimelineResponseSchema,
    error: ApiErrorSchema,
    response: { 200: DebugTimelineResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'DebugTimelineResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
