import { z } from 'zod';
import { cardIdSchema, processStatusSchema } from '../schemas/index.js';
import { buildScopedPathUrl, parseScopedPathUrl } from './scoped-path-url.js';
import {
  ApiErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

function isCanonicalProcessLogUrl(filename: string): (value: string | null) => boolean {
  return (value) => {
    if (value === null) return true;
    try {
      const parsed = parseScopedPathUrl(value, 'work');
      const nonCard = parsed.segments.length === 3
        && parsed.segments[0] === 'processes'
        && parsed.segments[1] !== ''
        && parsed.segments[2] === filename;
      const cardOwned = parsed.segments.length === 5
        && parsed.segments[0] === 'cards'
        && parsed.segments[1] !== ''
        && parsed.segments[2] === 'processes'
        && parsed.segments[3] !== ''
        && parsed.segments[4] === filename;
      return parsed.query === null && !parsed.hadFragment && (nonCard || cardOwned) && buildScopedPathUrl('work', parsed.segments) === value;
    } catch {
      return false;
    }
  };
}

export const ProcessLogRefsSchema = z.object({
  stdout: z.string().nullable().refine(isCanonicalProcessLogUrl('stdout.log'), 'stdout must be a canonical work:///cards/<cardId>/processes/<id>/stdout.log or work:///processes/<id>/stdout.log URL or null'),
  stderr: z.string().nullable().refine(isCanonicalProcessLogUrl('stderr.log'), 'stderr must be a canonical work:///cards/<cardId>/processes/<id>/stderr.log or work:///processes/<id>/stderr.log URL or null'),
});

export const ProcessViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  owner_id: z.string(),
  owner_kind: z.enum(['agent', 'operator', 'runtime']),
  session_id: z.string().nullable(),
  card_id: cardIdSchema.nullable(),
  command: z.string(),
  cwd: z.string().nullable(),
  logs: ProcessLogRefsSchema,
});

export const ProcessToolResultSchema = z.object({
  process_id: z.string().min(1),
  exit_code: z.number().int().nullable(),
  status: processStatusSchema,
  stdout_url: z.string().refine(isCanonicalProcessLogUrl('stdout.log'), 'stdout_url must be a canonical process stdout work URL'),
  stderr_url: z.string().refine(isCanonicalProcessLogUrl('stderr.log'), 'stderr_url must be a canonical process stderr work URL'),
  stdout_bytes: z.number().int().nonnegative(),
  stderr_bytes: z.number().int().nonnegative(),
}).strict();

export const ProcessListResponseSchema = z.object({ processes: z.array(ProcessViewSchema) });

export type ProcessView = z.infer<typeof ProcessViewSchema>;
export type ProcessToolResult = z.infer<typeof ProcessToolResultSchema>;
export type ProcessListResponse = z.infer<typeof ProcessListResponseSchema>;

export const processesOperatorApiContracts = {
  'processes.list': {
    operationId: 'processes.list',
    method: 'GET',
    path: '/api/processes',
    success: ProcessListResponseSchema,
    error: ApiErrorSchema,
    response: { 200: ProcessListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'ProcessListResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
