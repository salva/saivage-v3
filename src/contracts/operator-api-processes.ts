import { z } from 'zod';
import {
  ApiErrorSchema,
  publicContract,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const ProcessIdParamsSchema = z.object({ id: z.string().min(1) });

export const ProcessLogRefsSchema = z.object({
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  combined: z.string().nullable(),
});

export const ProcessViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  owner_id: z.string().nullable(),
  owner: z.string().nullable(),
  session_id: z.string().nullable(),
  card_id: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  logs: ProcessLogRefsSchema,
});

export const ProcessListResponseSchema = z.object({ processes: z.array(ProcessViewSchema) });
export const ProcessDetailResponseSchema = z.object({ process: ProcessViewSchema });
export const ProcessNotFoundErrorSchema = ApiErrorSchema.extend({
  error: z.literal('Process not found'),
  processId: z.string(),
});

export type ProcessView = z.infer<typeof ProcessViewSchema>;
export type ProcessListResponse = z.infer<typeof ProcessListResponseSchema>;
export type ProcessDetailResponse = z.infer<typeof ProcessDetailResponseSchema>;

export const processesOperatorApiContracts = {
  'processes.list': {
    operationId: 'processes.list',
    method: 'GET',
    path: '/api/processes',
    success: ProcessListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ProcessListResponseSchema, 400: ValidationErrorSchema, 500: ApiErrorSchema },
    ...publicContract,
    successSchemaName: 'ProcessListResponse',
  },
  'processes.get': {
    operationId: 'processes.get',
    method: 'GET',
    path: '/api/processes/:id',
    params: ProcessIdParamsSchema,
    success: ProcessDetailResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ProcessDetailResponseSchema, 400: ApiErrorSchema, 404: ProcessNotFoundErrorSchema, 500: ApiErrorSchema },
    ...publicContract,
    successSchemaName: 'ProcessDetailResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
