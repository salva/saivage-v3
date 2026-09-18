import { z } from 'zod';
import { cardIdSchema, processStatusSchema } from '../schemas/index.js';
import { buildScopedPathUrl, parseScopedPathUrl } from './scoped-path-url.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
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

const processResultIdSchema = z.string().regex(/^proc-[0-9a-f]{12}$/u);

interface ProcessResultLogLocation {
  readonly cardId: string | null;
  readonly processId: string;
}

function processResultLogLocation(value: string, filename: string): ProcessResultLogLocation | null {
  try {
    const parsed = parseScopedPathUrl(value, 'work');
    if (parsed.query !== null || parsed.hadFragment || buildScopedPathUrl('work', parsed.segments) !== value) return null;
    if (parsed.segments.length === 3
      && parsed.segments[0] === 'processes'
      && parsed.segments[2] === filename) {
      return { cardId: null, processId: parsed.segments[1]! };
    }
    if (parsed.segments.length === 5
      && parsed.segments[0] === 'cards'
      && cardIdSchema.safeParse(parsed.segments[1]).success
      && parsed.segments[2] === 'processes'
      && parsed.segments[4] === filename) {
      return { cardId: parsed.segments[1]!, processId: parsed.segments[3]! };
    }
    return null;
  } catch {
    return null;
  }
}

function hasAtMostThirtyLines(value: string): boolean {
  let lines = 0;
  for (const character of value) if (character === '\n') lines += 1;
  if (value.length > 0 && !value.endsWith('\n')) lines += 1;
  return lines <= 30;
}

const processOutputHeadSchema = z.string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 2_048, 'process output head must not exceed 2048 UTF-8 bytes')
  .refine(hasAtMostThirtyLines, 'process output head must not exceed 30 lines');

export const ProcessLogRefsSchema = z.object({
  stdout: z.string().nullable().refine(isCanonicalProcessLogUrl('stdout.log'), 'stdout must be a canonical work:///cards/<cardId>/processes/<id>/stdout.log or work:///processes/<id>/stdout.log URL or null'),
  stderr: z.string().nullable().refine(isCanonicalProcessLogUrl('stderr.log'), 'stderr must be a canonical work:///cards/<cardId>/processes/<id>/stderr.log or work:///processes/<id>/stderr.log URL or null'),
}).strict();

export const ProcessViewSchema = z.object({
  id: z.string(),
  status: processStatusSchema,
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
}).strict();

export const ProcessToolResultSchema = z.object({
  process_id: processResultIdSchema,
  exit_code: z.number().int().nullable(),
  status: processStatusSchema,
  stdout: processOutputHeadSchema,
  stderr: processOutputHeadSchema,
  stdout_complete: z.boolean(),
  stderr_complete: z.boolean(),
  stdout_url: z.string(),
  stderr_url: z.string(),
  stdout_bytes: z.number().int().nonnegative(),
  stderr_bytes: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const stdout = processResultLogLocation(value.stdout_url, 'stdout.log');
  const stderr = processResultLogLocation(value.stderr_url, 'stderr.log');
  if (!stdout) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stdout_url'], message: 'stdout_url must be a canonical process stdout work URL' });
  if (!stderr) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stderr_url'], message: 'stderr_url must be a canonical process stderr work URL' });
  if (stdout && stdout.processId !== value.process_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stdout_url'], message: 'stdout_url process identity must equal process_id' });
  if (stderr && stderr.processId !== value.process_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stderr_url'], message: 'stderr_url process identity must equal process_id' });
  if (stdout && stderr && stdout.cardId !== stderr.cardId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stderr_url'], message: 'process log URLs must name the same process directory' });
});

export const ProcessListResponseSchema = z.object({ processes: z.array(ProcessViewSchema) }).strict();

export type ProcessView = z.infer<typeof ProcessViewSchema>;
export type ProcessToolResult = z.infer<typeof ProcessToolResultSchema>;
export const processesOperatorApiContracts = {
  'processes.list': {
    operationId: 'processes.list',
    method: 'GET',
    path: '/api/processes',
    success: ProcessListResponseSchema,
    response: { 200: ProcessListResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
