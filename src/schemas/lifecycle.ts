import { z } from 'zod';
import type { CardRecord } from './types.js';

const arbitraryRecordSchema = z.record(z.string(), z.unknown());
const nullableArbitraryRecordSchema = arbitraryRecordSchema.nullable();
const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime();

export interface SelfReport {
  result: string;
  outcome: string;
  summary: string;
  status_text: string;
  at: string;
}

export interface ExecutorSuccessResult extends Record<string, unknown> {
  kind: 'executor_success';
  executor: Record<string, unknown>;
  generated_files: string[];
  verified_at: string;
  latest_self_report: SelfReport;
  warnings: string[];
}

export interface ExecutorFailureResult extends Record<string, unknown> {
  kind: 'executor_failure';
  error: string;
  partial_result: Record<string, unknown> | null;
  latest_self_report: SelfReport;
}

export interface ExecutorNeedsVerificationResult extends Record<string, unknown> {
  kind: 'executor_needs_verification';
  reason: string;
  preserved_result: Record<string, unknown>;
  fallback_reason: string | null;
  latest_self_report: SelfReport;
}

export interface PlannerDoneResult extends Record<string, unknown> {
  kind: 'planner_done';
  created_cards: string[];
  updated_cards: string[];
  summary: string;
}

export interface PlannerBlockedResult extends Record<string, unknown> {
  kind: 'planner_blocked';
  blocked_reason: string;
  resume_reason: string;
  created_cards: string[];
  updated_cards: string[];
}

export interface ReviewerPassResult extends Record<string, unknown> {
  kind: 'reviewer_pass';
  planning: PlannerDoneResult | PlannerBlockedResult;
  review_summary: string;
  assessment_id: string;
}

export interface ReviewerCorrectionResult {
  kind: 'reviewer_correction';
  issues: Array<Record<string, unknown>>;
  summary: string;
  assessment_id: string;
}

export type CardResult =
  | ExecutorSuccessResult
  | ExecutorFailureResult
  | ExecutorNeedsVerificationResult
  | PlannerDoneResult
  | PlannerBlockedResult
  | ReviewerPassResult;

export type DoneResult = ExecutorSuccessResult | PlannerDoneResult | ReviewerPassResult;
export type FailureResult = ExecutorFailureResult;
export type BlockedResult = PlannerBlockedResult;
export type NeedsVerificationResult = ExecutorNeedsVerificationResult;

export type CardLifecycleState =
  | { status: 'drafting'; result: null; error: null; completed_at: null }
  | { status: 'backlog'; result: null; error: null; completed_at: null }
  | { status: 'active'; result: CardResult | null; error: string | null; completed_at: null }
  | { status: 'running'; result: CardResult | null; error: string | null; completed_at: null }
  | { status: 'changed'; result: CardResult | null; error: string | null; completed_at: null }
  | { status: 'done'; result: DoneResult; error: null; completed_at: string }
  | { status: 'failed'; result: FailureResult; error: string; completed_at: string }
  | { status: 'blocked'; result: BlockedResult; error: string; completed_at: null }
  | { status: 'needs_verification'; result: NeedsVerificationResult; error: null; completed_at: null }
  | { status: 'cancelled'; result: null; error: null; completed_at: string | null };

export type ActivationOutcome =
  | { outcome: 'done'; completed_at: string; result: DoneResult }
  | { outcome: 'failed'; completed_at: string; error: string; result: FailureResult }
  | { outcome: 'blocked'; error: string; result: BlockedResult }
  | { outcome: 'cancelled'; completed_at: string | null }
  | { outcome: 'needs_verification'; reason: string; result: NeedsVerificationResult };

export type RuntimeRunOutcome =
  | { outcome: 'done'; completed_at: string; result: DoneResult }
  | { outcome: 'failed'; completed_at: string; error: string; result: FailureResult }
  | { outcome: 'blocked'; error: string; result: BlockedResult }
  | { outcome: 'cancelled'; completed_at: string | null }
  | { outcome: 'stopped'; stopped_at: string; reason: string | null }
  | { outcome: 'needs_verification'; reason: string; result: NeedsVerificationResult };

export const selfReportSchema: z.ZodType<SelfReport> = z.object({
  result: z.string(),
  outcome: z.string(),
  summary: z.string(),
  status_text: z.string(),
  at: timestampSchema,
}).strict();

export const executorSuccessResultSchema: z.ZodType<ExecutorSuccessResult> = z.object({
  kind: z.literal('executor_success'),
  executor: arbitraryRecordSchema,
  generated_files: z.array(z.string()),
  verified_at: timestampSchema,
  latest_self_report: selfReportSchema,
  warnings: z.array(z.string()),
}).strict();

export const executorFailureResultSchema: z.ZodType<ExecutorFailureResult> = z.object({
  kind: z.literal('executor_failure'),
  error: nonEmptyStringSchema,
  partial_result: nullableArbitraryRecordSchema,
  latest_self_report: selfReportSchema,
}).strict();

export const executorNeedsVerificationResultSchema: z.ZodType<ExecutorNeedsVerificationResult> = z.object({
  kind: z.literal('executor_needs_verification'),
  reason: nonEmptyStringSchema,
  preserved_result: arbitraryRecordSchema,
  fallback_reason: z.string().nullable(),
  latest_self_report: selfReportSchema,
}).strict();

export const plannerDoneResultSchema: z.ZodType<PlannerDoneResult> = z.object({
  kind: z.literal('planner_done'),
  created_cards: z.array(z.string()),
  updated_cards: z.array(z.string()),
  summary: z.string(),
}).strict();

export const plannerBlockedResultSchema: z.ZodType<PlannerBlockedResult> = z.object({
  kind: z.literal('planner_blocked'),
  blocked_reason: nonEmptyStringSchema,
  resume_reason: nonEmptyStringSchema,
  created_cards: z.array(z.string()),
  updated_cards: z.array(z.string()),
}).strict();

export const reviewerPassResultSchema: z.ZodType<ReviewerPassResult> = z.object({
  kind: z.literal('reviewer_pass'),
  planning: z.union([plannerDoneResultSchema, plannerBlockedResultSchema]),
  review_summary: z.string(),
  assessment_id: nonEmptyStringSchema,
}).strict();

export const reviewerCorrectionResultSchema: z.ZodType<ReviewerCorrectionResult> = z.object({
  kind: z.literal('reviewer_correction'),
  issues: z.array(arbitraryRecordSchema),
  summary: z.string(),
  assessment_id: nonEmptyStringSchema,
}).strict();

export const cardResultSchema: z.ZodType<CardResult> = z.union([
  executorSuccessResultSchema,
  executorFailureResultSchema,
  executorNeedsVerificationResultSchema,
  plannerDoneResultSchema,
  plannerBlockedResultSchema,
  reviewerPassResultSchema,
]);

export const doneResultSchema: z.ZodType<DoneResult> = z.union([executorSuccessResultSchema, plannerDoneResultSchema, reviewerPassResultSchema]);
export const failureResultSchema: z.ZodType<FailureResult> = executorFailureResultSchema;
export const blockedResultSchema: z.ZodType<BlockedResult> = plannerBlockedResultSchema;
export const needsVerificationResultSchema: z.ZodType<NeedsVerificationResult> = executorNeedsVerificationResultSchema;

export const cardLifecycleStateSchema: z.ZodType<CardLifecycleState> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('drafting'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('backlog'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('active'), result: cardResultSchema.nullable(), error: z.string().nullable(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('running'), result: cardResultSchema.nullable(), error: z.string().nullable(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('changed'), result: cardResultSchema.nullable(), error: z.string().nullable(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('done'), result: doneResultSchema, error: z.null(), completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('failed'), result: failureResultSchema, error: nonEmptyStringSchema, completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('blocked'), result: blockedResultSchema, error: nonEmptyStringSchema, completed_at: z.null() }).strict(),
  z.object({ status: z.literal('needs_verification'), result: needsVerificationResultSchema, error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('cancelled'), result: z.null(), error: z.null(), completed_at: timestampSchema.nullable() }).strict(),
]);

export const activationOutcomeSchema: z.ZodType<ActivationOutcome> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), completed_at: timestampSchema, result: doneResultSchema }).strict(),
  z.object({ outcome: z.literal('failed'), completed_at: timestampSchema, error: nonEmptyStringSchema, result: failureResultSchema }).strict(),
  z.object({ outcome: z.literal('blocked'), error: nonEmptyStringSchema, result: blockedResultSchema }).strict(),
  z.object({ outcome: z.literal('cancelled'), completed_at: timestampSchema.nullable() }).strict(),
  z.object({ outcome: z.literal('needs_verification'), reason: nonEmptyStringSchema, result: needsVerificationResultSchema }).strict(),
]);

export const runtimeRunOutcomeSchema: z.ZodType<RuntimeRunOutcome> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done'), completed_at: timestampSchema, result: doneResultSchema }).strict(),
  z.object({ outcome: z.literal('failed'), completed_at: timestampSchema, error: nonEmptyStringSchema, result: failureResultSchema }).strict(),
  z.object({ outcome: z.literal('blocked'), error: nonEmptyStringSchema, result: blockedResultSchema }).strict(),
  z.object({ outcome: z.literal('cancelled'), completed_at: timestampSchema.nullable() }).strict(),
  z.object({ outcome: z.literal('stopped'), stopped_at: timestampSchema, reason: z.string().nullable() }).strict(),
  z.object({ outcome: z.literal('needs_verification'), reason: nonEmptyStringSchema, result: needsVerificationResultSchema }).strict(),
]);

export type LifecycleProjectionInput = Pick<CardRecord, 'status' | 'updated_at' | 'result' | 'error' | 'completed_at'>;

export function projectCardLifecycleState(card: LifecycleProjectionInput): CardLifecycleState {
  switch (card.status) {
    case 'drafting':
    case 'backlog':
      return cardLifecycleStateSchema.parse({ status: card.status, result: card.result, error: card.error, completed_at: card.completed_at });
    case 'active':
    case 'running':
    case 'changed':
      return cardLifecycleStateSchema.parse({ status: card.status, result: card.result, error: card.error, completed_at: card.completed_at });
    case 'done':
      return cardLifecycleStateSchema.parse({ status: 'done', result: card.result, error: card.error, completed_at: card.completed_at });
    case 'failed':
      return cardLifecycleStateSchema.parse({ status: 'failed', result: card.result, error: card.error, completed_at: card.completed_at });
    case 'blocked':
      return cardLifecycleStateSchema.parse({ status: 'blocked', result: card.result, error: card.error, completed_at: card.completed_at });
    case 'needs_verification':
      return cardLifecycleStateSchema.parse({ status: 'needs_verification', result: card.result, error: card.error, completed_at: card.completed_at });
    case 'cancelled':
      return cardLifecycleStateSchema.parse({ status: 'cancelled', result: card.result, error: card.error, completed_at: card.completed_at });
  }
}

export function validatePersistedCardLifecycle(card: LifecycleProjectionInput): CardLifecycleState {
  return projectCardLifecycleState(card);
}
