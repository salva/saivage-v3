/** Temporary admission refusal, not an owner failure or shutdown. */
export class WorkGcBusyError extends Error {
  constructor() {
    super('Work garbage collection is busy; retry after it finishes.');
    this.name = 'WorkGcBusyError';
  }
}
import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workGcMode = z.enum(['dry_run', 'delete']);
export const WorkGcRequestSchema = z
  .object({
    mode: workGcMode,
    before: z
      .string()
      .datetime({ offset: true })
      .regex(/(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u)
      .optional(),
    target_bytes: count.optional(),
    min_file_bytes: count.optional(),
  })
  .strict();
export type WorkGcRequest = z.infer<typeof WorkGcRequestSchema>;
const operationalProtectionSources = [
  'process_capture',
  'unfinished_execution',
  'workflow_input',
  'operational_input',
] as const;
export const FirstGlobalProtectionSchema = z
  .object({
    reason: z.enum(['process_owner_uncertain', 'operational_root']),
    source: z.enum(['process_owner', ...operationalProtectionSources]),
  })
  .strict()
  .refine(
    (mark) => (mark.reason === 'process_owner_uncertain') === (mark.source === 'process_owner'),
    'GC global protection source must match its reason.',
  );
export type FirstGlobalProtection = z.infer<typeof FirstGlobalProtectionSchema>;
export type WorkGcProtectionSource =
  | FirstGlobalProtection['source']
  | 'card_content'
  | 'pending_notification'
  | 'record_content'
  | 'conversation_content';
const workGcPhase = z.enum(['inventory', 'settling', 'retention_marking', 'selection']);
const workGcCounters = z
  .object({
    observed_count: count.optional(),
    observed_logical_bytes: count.optional(),
    opaque_entries: count.optional(),
    inspected_cards: count.optional(),
    inspected_records: count.optional(),
    inspected_sessions: count.optional(),
    candidates_processed: count.optional(),
    would_delete_count: count.optional(),
    would_delete_logical_bytes: count.optional(),
    deleted_count: count.optional(),
    deleted_logical_bytes: count.optional(),
  })
  .strict();
export const WorkGcProgressSchema = workGcCounters.extend({
  first_global_protection: FirstGlobalProtectionSchema.nullable(),
  phase: workGcPhase,
  elapsed_ms: count,
});
export type WorkGcProgress = z.infer<typeof WorkGcProgressSchema>;
export type WorkGcProgressObserver = (progress: WorkGcProgress) => void;
export type WorkGcCounters = z.infer<typeof workGcCounters>;
export type WorkGcProgressUpdate = WorkGcCounters &
  Partial<Pick<WorkGcProgress, 'first_global_protection'>>;
const retentionSourceSteps = [
  'card_projection',
  'pending_notification',
  'record_listing',
  'record_projection',
  'execution_workflow_inputs',
  'conversation_projection',
] as const;
type WorkGcRetentionSourceStep = (typeof retentionSourceSteps)[number];
const WorkGcActiveStatusSchema = z
  .object({
    mode: workGcMode,
    phase: workGcPhase,
    substep: z.enum([
      'starting',
      'enumerating',
      'waiting_for_hold',
      'operational_inputs',
      ...retentionSourceSteps,
      'classifying',
    ]),
    elapsed_ms: count,
    step_elapsed_ms: count,
    last_checkpoint_elapsed_ms: count,
    counters: workGcCounters.extend({ reference_visits: count.optional() }),
    first_global_protection: FirstGlobalProtectionSchema.nullable(),
  })
  .strict();
export type WorkGcActiveStatus = z.infer<typeof WorkGcActiveStatusSchema>;
export const WorkGcStatusSchema = z
  .object({ active: WorkGcActiveStatusSchema.nullable() })
  .strict();
export type WorkGcStatus = z.infer<typeof WorkGcStatusSchema>;
/** Transient observations only; never collection or publication authority. */
export interface WorkGcProgressPort {
  phase(phase: WorkGcProgress['phase'], values?: WorkGcProgressUpdate): void;
  update(values: WorkGcProgressUpdate): void;
  increment(counter: keyof WorkGcCounters): void;
  retentionSource?(step: WorkGcRetentionSourceStep): void;
  referenceVisits?(total: number): void;
}
const WorkGcResultSchema = z
  .object({
    mode: workGcMode,
    observed_count: count,
    observed_logical_bytes: count,
    opaque_entries: count,
    whole_work_size_known: z.literal(false),
    first_global_protection: FirstGlobalProtectionSchema.nullable(),
    retained: z
      .object({
        protected: count,
        recent: count,
        stale: count,
        opaque: count,
        target: count,
        below_min_file_bytes: count.optional(),
      })
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
    mode: workGcMode,
    disposition: z.enum(['completed', 'interrupted', 'refused']),
    reason: z.enum([
      'completed',
      'cancelled',
      'inventory_failed',
      'operational_inputs_invalid',
      'collection_failed',
      'reference_scope_unresolved',
      'maintenance_refused',
    ]),
    restoration: z.enum(['not_acquired', 'resumed', 'not_resumed']),
    failure: z
      .object({
        code: z.enum([
          'EACCES',
          'EPERM',
          'ENOENT',
          'ENOTDIR',
          'EISDIR',
          'ENAMETOOLONG',
          'ELOOP',
          'EMFILE',
          'ENFILE',
          'ENOSPC',
          'EROFS',
          'EIO',
          'unknown',
        ]),
        syscall: z
          .enum(['scandir', 'readdir', 'lstat', 'stat', 'realpath', 'open', 'read', 'close'])
          .nullable(),
      })
      .strict()
      .nullable(),
    result: WorkGcResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result && value.result.mode !== value.mode)
      ctx.addIssue({ code: 'custom', message: 'GC result mode mismatch.' });
    if (value.disposition === 'completed' && (!value.result || value.reason !== 'completed'))
      ctx.addIssue({ code: 'custom', message: 'Completed GC requires its result.' });
    if (
      value.reason === 'reference_scope_unresolved' &&
      (value.disposition !== 'refused' || value.result !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Unresolved GC reference scope refuses before selection.',
      });
    if (
      (value.disposition === 'completed' || value.reason === 'cancelled') !==
      (value.failure === null)
    )
      ctx.addIssue({ code: 'custom', message: 'GC failure metadata must match its outcome.' });
  });
export type WorkGcResponse = z.infer<typeof WorkGcResponseSchema>;
export type WorkGcResult = z.infer<typeof WorkGcResultSchema>;
export const WORK_GC_FRAME_MAX_BYTES = 16 * 1024;
export const WorkGcFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), progress: WorkGcProgressSchema }).strict(),
  z.object({ type: z.literal('result'), response: WorkGcResponseSchema }).strict(),
]);
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
