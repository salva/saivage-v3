import { z } from 'zod';
import { agentNameSchema } from './agent-name.js';
import { processIdSchema } from './process-id.js';
import { uuidV4Schema } from './uuid.js';

/** Immutable authorship, not an assessment or a guarantee of command effects. */
export const recordAuthorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agent: agentNameSchema }).strict(),
    z.object({ kind: z.literal('runtime'), purpose: z.enum(['bootstrap', 'repair']) }).strict(),
    z
      .object({
        kind: z.literal('shell-stdout'),
        action: z.literal('shell.run'),
        contract_version: z.literal(1),
        activation_id: uuidV4Schema,
        invocation_id: uuidV4Schema,
        node_id: z.string().min(1),
        ordinal: z.number().int().safe().nonnegative(),
        process_id: processIdSchema,
        stream: z.literal('stdout'),
        outcome: z.enum(['passed', 'failed', 'signalled', 'timed_out']),
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
    if (author.kind !== 'shell-stdout') return;
    const leader = author.leader_exit;
    const invalid =
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
        message: 'Shell stdout outcome contradicts observed leader exit.',
      });
  });

export type RecordAuthor = z.infer<typeof recordAuthorSchema>;
