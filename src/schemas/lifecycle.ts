import { z } from 'zod';
import { ConversationSessionIdSchema, type ConversationSessionId } from './conversation-session-id.js';

const nonEmptyStringSchema = z.string().min(1);
const timestampSchema = z.string().datetime();

export interface WorkflowResult extends Record<string, unknown> { kind:'workflow-result';terminal:'DONE'|'BLOCKED'|'FAILED';agent_name:string;node_id:string;outcome:string;summary:string;records:readonly {name:string;url:string;version:number}[] }
interface RuntimeFailureResult extends Record<string,unknown>{kind:'runtime-failure';summary:string}
export const CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY = 'Provider content policy blocked this card after one safety-respecting reframing attempt.' as const;
export const COMPACTION_SUMMARY_BLOCKED_SUMMARY = 'Internal conversation summarization was blocked by the provider after bounded recovery. No further automatic retry was attempted.' as const;
export interface ContentPolicyRefusalBlockedResult extends Record<string, unknown> {
  kind: 'content-policy-refusal';
  summary: typeof CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY;
  session_id: ConversationSessionId;
  marker_id: string;
  evidence_url: string;
}
export interface CompactionSummaryBlockedResult extends Record<string, unknown> {
  kind: 'compaction-summary-blocked';
  summary: typeof COMPACTION_SUMMARY_BLOCKED_SUMMARY;
  session_id: ConversationSessionId;
  summary_input_id: string;
}
export type RuntimeOwnedBlockedResult = ContentPolicyRefusalBlockedResult | CompactionSummaryBlockedResult;
export type DoneResult = WorkflowResult;
export type FailedResult = WorkflowResult | RuntimeFailureResult;
export type BlockedResult = WorkflowResult | RuntimeOwnedBlockedResult;

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

const workflowResultSchema: z.ZodType<WorkflowResult> = z.object({kind:z.literal('workflow-result'),terminal:z.enum(['DONE','BLOCKED','FAILED']),agent_name:nonEmptyStringSchema,node_id:nonEmptyStringSchema,outcome:nonEmptyStringSchema,summary:nonEmptyStringSchema,records:z.array(z.object({name:nonEmptyStringSchema,url:nonEmptyStringSchema,version:z.number().int().positive()}).strict())}).strict();
const runtimeFailureResultSchema: z.ZodType<RuntimeFailureResult> = z.object({kind:z.literal('runtime-failure'),summary:nonEmptyStringSchema}).strict();
const contentPolicyRefusalBlockedResultSchema: z.ZodType<ContentPolicyRefusalBlockedResult> = z.object({ kind: z.literal('content-policy-refusal'), summary: z.literal(CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY), session_id: ConversationSessionIdSchema, marker_id: nonEmptyStringSchema, evidence_url: nonEmptyStringSchema }).strict();
export const compactionSummaryBlockedResultSchema: z.ZodType<CompactionSummaryBlockedResult> = z.object({ kind: z.literal('compaction-summary-blocked'), summary: z.literal(COMPACTION_SUMMARY_BLOCKED_SUMMARY), session_id: ConversationSessionIdSchema, summary_input_id: z.string().uuid() }).strict();
const doneResultSchema: z.ZodType<DoneResult> = workflowResultSchema;
const failedResultSchema: z.ZodType<FailedResult> = z.union([workflowResultSchema,runtimeFailureResultSchema]);
const blockedResultSchema: z.ZodType<BlockedResult> = z.union([workflowResultSchema, contentPolicyRefusalBlockedResultSchema, compactionSummaryBlockedResultSchema]);

export const cardLifecycleStateSchema: z.ZodType<CardLifecycleState> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('backlog'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('running'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('changed'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('stopped'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
  z.object({ status: z.literal('done'), result: doneResultSchema, error: z.null(), completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('failed'), result: failedResultSchema, error: nonEmptyStringSchema, completed_at: timestampSchema }).strict(),
  z.object({ status: z.literal('blocked'), result: blockedResultSchema, error: nonEmptyStringSchema, completed_at: z.null() }).strict(),
  z.object({ status: z.literal('cancelled'), result: z.null(), error: z.null(), completed_at: z.null() }).strict(),
]);
