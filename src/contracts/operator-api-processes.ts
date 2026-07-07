import { z } from 'zod';
import { buildScopedPathUrl, parseScopedPathUrl } from '../workspace/index.js';
import {
  ApiErrorSchema,
  publicContract,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

export const ProcessIdParamsSchema = z.object({ id: z.string().min(1) });

function isCanonicalProcessLogUrl(filename: string): (value: string | null) => boolean {
  return (value) => {
    if (value === null) return true;
    try {
      const parsed = parseScopedPathUrl(value, 'work');
      return parsed.query === null
        && !parsed.hadFragment
        && parsed.segments.length === 3
        && parsed.segments[0] === 'processes'
        && parsed.segments[1] !== ''
        && parsed.segments[2] === filename
        && buildScopedPathUrl('work', parsed.segments) === value;
    } catch {
      return false;
    }
  };
}

export const ProcessLogRefsSchema = z.object({
  stdout: z.string().nullable().refine(isCanonicalProcessLogUrl('stdout.log'), 'stdout must be a canonical work:///processes/<id>/stdout.log URL or null'),
  stderr: z.string().nullable().refine(isCanonicalProcessLogUrl('stderr.log'), 'stderr must be a canonical work:///processes/<id>/stderr.log URL or null'),
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
