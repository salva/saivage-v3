import { z } from 'zod';
import {
  gitNativeStepSchema,
  nativeGitEffectSchema,
  nativeGitOutcomeSchema,
  nativeGitEvidenceFactsSchema,
  nativeGitExecutionBindingSchema,
} from '../schemas/index.js';
import { actionOutputDescriptorSchema, operationOutputSourceSchema } from '../schemas/index.js';
import { cardIdSchema, uuidV4Schema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';

const text = z.string().max(8192);
const binding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node'),
      activation_id: uuidV4Schema,
      node_id: text,
      ordinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('card-hook'),
      activation_id: uuidV4Schema,
      hook: z.literal('after_activation_commit'),
      committed_card_artifact: z
        .object({ entry_id: uuidV4Schema, version: z.number().int().positive() })
        .strict(),
      status: z.enum(['done', 'blocked', 'failed']),
    })
    .strict(),
]);
const observation = z.discriminatedUnion('type', [
  z.object({ name: text, type: z.literal('string'), value: text }).strict(),
  z.object({ name: text, type: z.literal('integer'), value: z.number().int().safe() }).strict(),
  z.object({ name: text, type: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ name: text, type: z.literal('strings'), value: z.array(text).max(256) }).strict(),
]);
const file = z
  .object({
    key: z.string(),
    label: text,
    source: z.enum(['capture', 'current']),
    observed_at: z.string().nullable(),
    size: z.number().int().nonnegative().nullable(),
  })
  .strict();
const row = z
  .object({
    family: z.literal('action'),
    row_id: uuidV4Schema,
    invocation_id: uuidV4Schema,
    timestamp: z.string(),
    kind: z.enum(['invocation_started', 'process_started', 'invocation_finished']),
    operation: text,
    contract_version: z.number().int().positive(),
    binding,
    disposition: text.nullable(),
  })
  .strict();
const CardExecutionListSchema = z
  .object({
    rows: z
      .array(
        z.discriminatedUnion('family', [
          row,
          row
            .omit({
              operation: true,
              contract_version: true,
              binding: true,
              kind: true,
              family: true,
            })
            .extend({
              family: z.literal('native'),
              kind: z.enum([
                'native_started',
                'native_process_started',
                'native_process_finished',
                'native_finished',
              ]),
              step: gitNativeStepSchema,
              binding: nativeGitExecutionBindingSchema,
            })
            .strict(),
        ]),
      )
      .max(100),
    next_cursor: uuidV4Schema.nullable(),
  })
  .strict();
const ActionExecutionDetailSchema = z
  .object({
    family: z.literal('action'),
    invocation_id: uuidV4Schema,
    operation: text,
    contract_version: z.number().int().positive(),
    provider: z.object({ kind: z.enum(['builtin', 'plugin']), name: text }).strict(),
    output_source: operationOutputSourceSchema.nullable(),
    artifact_paths: z.array(text).max(16),
    output: actionOutputDescriptorSchema.nullable(),
    binding,
    started_at: z.string(),
    finished_at: z.string().nullable(),
    completion: z.enum(['retained', 'no completion retained; effects unknown']),
    shell: z
      .object({ script: text, cwd: text, argv: z.array(text).max(264) })
      .strict()
      .nullable(),
    input: z.array(observation).max(32),
    disposition: text.nullable(),
    summary: text.nullable(),
    outcome: text.nullable(),
    leader_exit: z
      .object({
        exit_code: z.number().int().nullable(),
        signal: text.nullable(),
        observed_at: z.string(),
      })
      .strict()
      .nullable(),
    leader_error: z.object({ diagnostic: text, observed_at: z.string() }).strict().nullable(),
    interruption: text.nullable(),
    timeout_reason: text.nullable(),
    process: z
      .object({
        id: text,
        group: z.enum(['tracked', 'absent', 'unverifiable']),
        group_diagnostic: text.nullable(),
        stdout: text,
        stderr: text,
        stdout_error: text.nullable(),
        stderr_error: text.nullable(),
      })
      .strict()
      .nullable(),
    processes: z.array(z.object({ process_id: text, timestamp: z.string() }).strict()).max(100),
    processes_truncated: z.boolean(),
    values: z.array(observation).max(32),
    files: z.array(file).max(218),
    absent_artifacts: z.array(text).max(16),
    external_effects: z.literal('unknown'),
  })
  .strict();
const NativeExecutionDetailSchema = ActionExecutionDetailSchema.omit({
  family: true,
  operation: true,
  contract_version: true,
  provider: true,
  output_source: true,
  output: true,
  binding: true,
  shell: true,
  input: true,
  values: true,
  outcome: true,
  leader_exit: true,
  leader_error: true,
  process: true,
  processes: true,
})
  .extend({
    family: z.literal('native'),
    step: gitNativeStepSchema,
    binding: nativeGitExecutionBindingSchema,
    outcome: nativeGitOutcomeSchema.nullable(),
    effects: z.array(nativeGitEffectSchema).max(32),
    facts: nativeGitEvidenceFactsSchema.nullable(),
    source_return: z.enum(['returned', 'not_returned', 'unknown']),
    commands: z
      .array(
        z
          .object({
            process_id: text,
            timestamp: z.string(),
            allowed_exit_codes: z.array(z.number().int()).min(1).max(4),
            finished_at: z.string().nullable(),
            status: z.enum(['running', 'exited', 'failed', 'killed', 'unavailable']).nullable(),
            disposition: ActionExecutionDetailSchema.shape.disposition,
            leader_exit: ActionExecutionDetailSchema.shape.leader_exit,
            leader_error: ActionExecutionDetailSchema.shape.leader_error,
            process: ActionExecutionDetailSchema.shape.process,
            interruption: text.nullable(),
            timeout_reason: text.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const CardExecutionDetailSchema = z.discriminatedUnion('family', [
  ActionExecutionDetailSchema,
  NativeExecutionDetailSchema,
]);
const failure = z.object({ error: z.string() }).strict();
const params = z.object({ id: cardIdSchema }).strict();
const invocationParams = params.extend({ invocationId: uuidV4Schema }).strict();
const fileParams = invocationParams
  .extend({
    fileKey: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:0|[1-9][0-9]?)$/u,
      ),
  })
  .strict();
const content = z
  .object({
    content: z.string(),
    source: z.enum(['capture', 'current']),
    redacted: z.literal(true),
  })
  .strict();
const download = z.custom<Uint8Array<ArrayBufferLike>>(
  (value) => value instanceof Uint8Array && value.byteLength <= 4 * 1024 * 1024,
);
export const executionOperatorApiContracts = {
  'cards.executions.list': {
    ...operatorSessionContract,
    operationId: 'cards.executions.list',
    method: 'GET',
    path: '/api/cards/:id/executions',
    params,
    query: z
      .object({
        after: uuidV4Schema.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict(),
    success: CardExecutionListSchema,
    response: {
      200: CardExecutionListSchema,
      400: z.union([failure, ValidationErrorSchema]),
      401: UnauthorizedErrorSchema,
      403: failure,
      404: failure,
      413: failure,
      415: failure,
      500: UnexpectedInternalServerErrorSchema,
    },
  },
  'cards.executions.get': {
    ...operatorSessionContract,
    operationId: 'cards.executions.get',
    method: 'GET',
    path: '/api/cards/:id/executions/:invocationId',
    params: invocationParams,
    success: CardExecutionDetailSchema,
    response: {
      200: CardExecutionDetailSchema,
      400: z.union([failure, ValidationErrorSchema]),
      401: UnauthorizedErrorSchema,
      403: failure,
      404: failure,
      413: failure,
      415: failure,
      500: UnexpectedInternalServerErrorSchema,
    },
  },
  'cards.executions.file': {
    ...operatorSessionContract,
    operationId: 'cards.executions.file',
    method: 'GET',
    path: '/api/cards/:id/executions/:invocationId/files/:fileKey',
    params: fileParams,
    success: content,
    response: {
      200: content,
      400: z.union([failure, ValidationErrorSchema]),
      401: UnauthorizedErrorSchema,
      403: failure,
      404: failure,
      413: failure,
      415: failure,
      500: UnexpectedInternalServerErrorSchema,
    },
  },
  'cards.executions.download': {
    ...operatorSessionContract,
    operationId: 'cards.executions.download',
    method: 'GET',
    path: '/api/cards/:id/executions/:invocationId/files/:fileKey/download',
    params: fileParams,
    success: download,
    responseEncoding: 'binary',
    response: {
      200: download,
      400: z.union([failure, ValidationErrorSchema]),
      401: UnauthorizedErrorSchema,
      403: failure,
      404: failure,
      413: failure,
      415: failure,
      500: UnexpectedInternalServerErrorSchema,
    },
  },
} as const satisfies Record<string, OperatorRouteContract>;
