/** Temporary admission refusal, not an owner failure or shutdown. */
export class WorkGcBusyError extends Error {
  constructor() {
    super('Work garbage collection is busy; retry after it finishes.');
    this.name = 'WorkGcBusyError';
  }
}
import { z } from 'zod';

export const WorkGcRequestSchema = z
  .object({
    mode: z.enum(['dry_run', 'delete']),
    before: z
      .string()
      .datetime({ offset: true })
      .regex(/(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u)
      .optional(),
    target_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type WorkGcRequest = z.infer<typeof WorkGcRequestSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const WorkGcResultSchema = z
  .object({
    mode: z.enum(['dry_run', 'delete']),
    observed_count: count,
    observed_logical_bytes: count,
    opaque_entries: count,
    whole_work_size_known: z.literal(false),
    retained: z
      .object({ protected: count, recent: count, stale: count, opaque: count, target: count })
      .strict(),
    would_delete_count: count,
    would_delete_logical_bytes: count,
    deleted_count: count,
    deleted_logical_bytes: count,
    expected_accounted_logical_bytes_remaining: count,
    accounted_target_shortfall: count.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.mode === 'dry_run'
        ? value.deleted_count !== 0 || value.deleted_logical_bytes !== 0
        : value.would_delete_count !== 0 || value.would_delete_logical_bytes !== 0
    )
      ctx.addIssue({ code: 'custom', message: 'Effect attribution must match GC mode.' });
  });
export const WorkGcResponseSchema = z
  .object({
    mode: z.enum(['dry_run', 'delete']),
    disposition: z.enum(['completed', 'interrupted', 'refused']),
    reason: z.enum([
      'completed',
      'cancelled',
      'inventory_failed',
      'operational_inputs_invalid',
      'collection_failed',
      'maintenance_refused',
    ]),
    restoration: z.enum(['not_acquired', 'resumed', 'not_resumed']),
    result: WorkGcResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result && value.result.mode !== value.mode)
      ctx.addIssue({ code: 'custom', message: 'GC result mode mismatch.' });
    if (value.disposition === 'completed' && (!value.result || value.reason !== 'completed'))
      ctx.addIssue({ code: 'custom', message: 'Completed GC requires its result.' });
  });
export type WorkGcResponse = z.infer<typeof WorkGcResponseSchema>;
export type WorkGcResult = z.infer<typeof WorkGcResultSchema>;
export const WorkGcBusyErrorSchema = z
  .object({
    error: z.literal('WorkGcBusy'),
    message: z.literal('Work garbage collection is busy.'),
  })
  .strict();
export const WORK_GC_BUSY_ERROR = WorkGcBusyErrorSchema.parse({
  error: 'WorkGcBusy',
  message: 'Work garbage collection is busy.',
});

/** Exact owner disposition on ordinary maintenance failure; never used for uncertainty. */
export class WorkGcMaintenanceError extends Error {
  constructor(
    readonly restoredRunning: boolean,
    cause: unknown,
    readonly cancelled = false,
  ) {
    super(cause instanceof Error ? cause.message : 'Work GC maintenance failed.', { cause });
  }
}
