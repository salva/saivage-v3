import { z } from 'zod';
import { processIdSchema } from './process-id.js';
import { uuidV4Schema } from './uuid.js';
import { operationAuthorSchema } from './operation-author.js';
import { operationIdSchema } from './operation-id.js';
import { actionOutputDescriptorSchema } from './action-output.js';

/** Immutable authorship, not an assessment or a guarantee of command effects. */
export const recordAuthorSchema = z
  .discriminatedUnion('kind', [
    ...operationAuthorSchema.options,
    z.object({ kind: z.literal('runtime'), purpose: z.enum(['bootstrap', 'repair']) }).strict(),
    z
      .object({
        kind: z.literal('action-output'),
        operation: operationIdSchema,
        contract_version: z.number().int().safe().positive(),
        provider: z
          .object({ kind: z.enum(['builtin', 'plugin']), name: z.string().min(1) })
          .strict(),
        activation_id: uuidV4Schema,
        invocation_id: uuidV4Schema,
        node_id: z.string().min(1),
        ordinal: z.number().int().safe().nonnegative(),
        process_id: processIdSchema.nullable(),
        output: actionOutputDescriptorSchema,
        outcome: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
        leader_exit: z
          .object({
            exit_code: z.number().int().safe().nullable(),
            signal: z.string().min(1).nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  ])
  .superRefine((author, ctx) => {
    if (author.kind !== 'action-output') return;
    const leader = author.leader_exit;
    if (
      author.provider.name !== author.operation.split('.')[0] ||
      (author.process_id === null && leader !== null) ||
      (author.output.source === 'command-stdout' && author.process_id === null) ||
      (leader !== null && (leader.exit_code === null) === (leader.signal === null))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Action output provenance is contradictory.',
      });
    if (author.operation !== 'shell.run') return;
    const invalid =
      author.contract_version !== 1 ||
      author.provider.kind !== 'builtin' ||
      author.output.source !== 'command-stdout' ||
      !['passed', 'failed', 'signalled', 'timed_out'].includes(author.outcome) ||
      (author.outcome === 'passed' &&
        (!leader || leader.exit_code !== 0 || leader.signal !== null)) ||
      (author.outcome === 'failed' &&
        (!leader ||
          leader.exit_code === null ||
          leader.exit_code === 0 ||
          leader.signal !== null)) ||
      (author.outcome === 'signalled' && (!leader?.signal || leader.exit_code !== null)) ||
      (leader !== null && leader.exit_code !== null && leader.signal !== null);
    if (invalid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Shell output outcome contradicts observed leader exit.',
      });
  });

export type RecordAuthor = z.infer<typeof recordAuthorSchema>;
