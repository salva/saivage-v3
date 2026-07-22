import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime();

export interface SelfReport {
  result: string;
  outcome: string;
  summary: string;
  status_text: string;
  at: string;
}

export interface DoneResult extends Record<string, unknown> {
  kind: 'done';
  summary: string;
}

export interface FailedResult extends Record<string, unknown> {
  kind: 'failed';
  summary: string;
}

export interface BlockedResult extends Record<string, unknown> {
  kind: 'blocked';
  summary: string;
  resume_reason?: string;
  blocker_cause?: 'reviewer_unavailable' | 'token_budget_exceeded' | 'generic';
}

export type CardResult = DoneResult | FailedResult | BlockedResult;

export type CardLifecycleState =
  | { status: 'backlog'; result: null; error: null; completed_at: null }
  | { status: 'running'; result: null; error: null; completed_at: null }
  | { status: 'changed'; result: null; error: null; completed_at: null }
  | { status: 'stopped'; result: null; error: null; completed_at: null }
  | { status: 'done'; result: DoneResult; error: null; completed_at: string }
  | { status: 'failed'; result: FailedResult; error: string; completed_at: string }
  | { status: 'blocked'; result: BlockedResult; error: string; completed_at: null }
  | { status: 'cancelled'; result: null; error: null; completed_at: null };

export type ActivationOutcome =
  | { outcome: 'done'; completed_at: string; result: DoneResult }
  | { outcome: 'failed'; completed_at: string; error: string; result: FailedResult }
  | { outcome: 'blocked'; error: string; result: BlockedResult }
  | { outcome: 'cancelled'; completed_at: string | null };

export type RuntimeRunOutcome =
  | { outcome: 'done'; completed_at: string; result: DoneResult }
  | { outcome: 'failed'; completed_at: string; error: string; result: FailedResult }
  | { outcome: 'blocked'; error: string; result: BlockedResult }
  | { outcome: 'cancelled'; completed_at: string | null }
  | { outcome: 'stopped'; stopped_at: string; reason: string | null };

export const selfReportSchema: z.ZodType<SelfReport> = z.object({
  result: z.string(),
  outcome: z.string(),
  summary: z.string(),
  status_text: z.string(),
  at: timestampSchema,
}).strict();

export const doneResultSchema: z.ZodType<DoneResult> = z.object({
  kind: z.literal('done'),
  summary: nonEmptyStringSchema,
}).strict();

export const failedResultSchema: z.ZodType<FailedResult> = z.object({
  kind: z.literal('failed'),
  summary: nonEmptyStringSchema,
}).strict();

export const blockedResultSchema: z.ZodType<BlockedResult> = z.object({
  kind: z.literal('blocked'),
  summary: nonEmptyStringSchema,
  resume_reason: nonEmptyStringSchema.optional(),
  blocker_cause: z.enum(['reviewer_unavailable', 'token_budget_exceeded', 'generic']).optional(),
}).strict();

export const cardResultSchema: z.ZodType<CardResult> = z.union([
  doneResultSchema,
  failedResultSchema,
  blockedResultSchema,
]);

export const failedLifecycleResultSchema: z.ZodType<FailedResult> = failedResultSchema;
export const blockedLifecycleResultSchema: z.ZodType<BlockedResult> = blockedResultSchema;

export const cardLifecycleStateSchema: z.ZodType<CardLifecycleState> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('backlog'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('running'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('changed'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('stopped'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('done'), result: doneResultSchema, error: z.null(), completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('failed'), result: failedLifecycleResultSchema, error: nonEmptyStringSchema, completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('blocked'), result: blockedLifecycleResultSchema, error: nonEmptyStringSchema, completed_at: z.null() }).strict(),
  z.object({ status: z.literal('cancelled'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
]);

export const activationOutcomeSchema: z.ZodType<ActivationOutcome> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), completed_at: timestampSchema, result: doneResultSchema }).strict(),
  z.object({ outcome: z.literal('failed'), completed_at: timestampSchema, error: nonEmptyStringSchema, result: failedLifecycleResultSchema }).strict(),
  z.object({ outcome: z.literal('blocked'), error: nonEmptyStringSchema, result: blockedLifecycleResultSchema }).strict(),
  z.object({ outcome: z.literal('cancelled'), completed_at: timestampSchema.nullable() }).strict(),
]);

export const runtimeRunOutcomeSchema: z.ZodType<RuntimeRunOutcome> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), completed_at: timestampSchema, result: doneResultSchema }).strict(),
  z.object({ outcome: z.literal('failed'), completed_at: timestampSchema, error: nonEmptyStringSchema, result: failedLifecycleResultSchema }).strict(),
  z.object({ outcome: z.literal('blocked'), error: nonEmptyStringSchema, result: blockedLifecycleResultSchema }).strict(),
  z.object({ outcome: z.literal('cancelled'), completed_at: timestampSchema.nullable() }).strict(),
  z.object({ outcome: z.literal('stopped'), stopped_at: timestampSchema, reason: z.string().nullable() }).strict(),
]);
