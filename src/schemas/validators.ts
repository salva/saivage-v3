import { z } from 'zod';
import {
  agentEventKindValues,
  eventKindValues,
  runtimeEventKindValues,
  type EventKind,
  type LoggedEvent,
  agentRoleValues,
  analystIssueSeverityValues,
  cardActionValues,
  cardStatusValues,
  cardTypeValues,
  urgencyValues,
} from './types.js';
import { buildLoggedEventSchema } from './event-catalog.js';
import { roundIdGrammar } from './round-id.js';
import { cardLifecycleStateSchema } from './lifecycle.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolErrorMessageId, sourceInputIdFromToolResultMessageId } from './message-identity.js';
export { roundIdGrammar, assertRoundId, type RoundKind } from './round-id.js';


function enumFromCatalog(values: readonly string[]) { return z.enum(values as unknown as [string, ...string[]]); }

export const cardTypeSchema = z.enum(cardTypeValues);
export const cardStatusSchema = z.enum(cardStatusValues);
export const cardActionSchema = z.enum(cardActionValues);
export const urgencySchema = z.enum(urgencyValues);
export const createdBySchema = z.enum(['user', 'analyst', 'planner']);
export const noteAuthorSchema = z.enum(['user', 'analyst', 'planner', 'executor', 'reviewer', 'runtime']);
export const controlActionSurfaceSchema = z.enum(['web-chat', 'telegram', 'rest', 'cli', 'runtime', 'web-ui']);
export const cardMetadataSchema: z.ZodType<import('./types.js').CardMetadata> = z.object({ max_review_retries: z.number().int().nonnegative().optional() }).catchall(z.unknown());
const cardRecordShape = { id: z.string().min(1), type: cardTypeSchema, parent: z.string().nullable(), depth: z.number().int().min(0), position: z.number().int().nonnegative(), title: z.string().min(1), status: cardStatusSchema, lifecycle: cardLifecycleStateSchema, subtype: z.string().nullable().optional(), tags: z.array(z.string()), priority: z.number().int(), urgency: urgencySchema, created_by: createdBySchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), version_seq: z.number().int().positive(), assigned_to: z.string().nullable().optional(), depends_on: z.array(z.string()), related: z.array(z.string()), metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).nullable().optional(), estimate: z.string().nullable().optional(), started_at: z.string().datetime().nullable().optional(), duration_ms: z.number().int().nonnegative().nullable().optional(), status_text: z.string().nullable().optional(), status_text_updated_at: z.string().datetime().nullable().optional(), status_text_author_session_id: z.string().nullable().optional(), latest_self_report: z.record(z.string(), z.unknown()).nullable().optional(), metadata: cardMetadataSchema.nullable().optional(), allowedActions: z.array(cardActionSchema).optional(), retries: z.number().int().nonnegative() };
function refineCardLifecycle(card: import('./types.js').CardRecord, ctx: z.RefinementCtx): void { if (card.status !== card.lifecycle.status) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Card status must match lifecycle.status', path: ['status'] }); }
export const cardRecordSchema: z.ZodType<import('./types.js').CardRecord> = z.lazy(() => z.object(cardRecordShape).superRefine(refineCardLifecycle));
export const persistedCardRecordSchema: z.ZodType<import('./types.js').CardRecord> = z.lazy(() => z.object(cardRecordShape).strict().superRefine(refineCardLifecycle));
export const cardOperatorSummarySchema: z.ZodType<import('./types.js').CardOperatorSummary> = z.object({ lifecycleStatus: cardStatusSchema, terminal: z.boolean(), blocked: z.boolean(), hasError: z.boolean(), error: z.string().nullable(), completedAt: z.string().nullable(), stale: z.boolean(), actionCount: z.number().int().nonnegative() });
export const cardViewSchema: z.ZodType<import('./types.js').CardView> = cardRecordSchema.and(z.object({ display_path: z.string().nullable(), operator_summary: cardOperatorSummarySchema }));
export const cardRefViewSchema: z.ZodType<import('./types.js').CardRefView> = z.object({ id: z.string().min(1), display_path: z.string().nullable(), title: z.string().nullable(), missing: z.boolean().optional() });
export const cardHistoryKindSchema = z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']);
const cardHistoryEntryBaseSchema = z.object({ entry_id: z.string().uuid(), kind: cardHistoryKindSchema, card_id: z.string().min(1), version_seq: z.number().int().positive(), snapshot: persistedCardRecordSchema, changed_at: z.string().datetime(), changed_by_actor: noteAuthorSchema, changed_by_surface: controlActionSurfaceSchema, change_reason: z.string().nullable(), changed_fields: z.array(z.string()), change_summary: z.string() });
export const cardHistoryHeaderSchema: z.ZodType<import('./types.js').CardHistoryHeader> = cardHistoryEntryBaseSchema.omit({ snapshot: true });
export const cardHistoryEntrySchema: z.ZodType<import('./types.js').CardHistoryEntry> = cardHistoryEntryBaseSchema;
export const controlActionAuditEntrySchema: z.ZodType<import('./types.js').ControlActionAuditEntry> = z.object({ id: z.string().min(1), actor: noteAuthorSchema, surface: controlActionSurfaceSchema, action: z.string().min(1), target_kind: z.enum(['card', 'note', 'process', 'runtime', 'config', 'session']).nullable(), target_id: z.string().nullable(), params_summary: z.string(), safety_class: z.enum(['read_only', 'low', 'high', 'destructive', 'deployment']).optional(), outcome: z.enum(['ok', 'error', 'denied']), outcome_summary: z.string(), error: z.string().optional(), created_at: z.string().datetime() });
export const cardIndexEntrySchema = z.object({ id: z.string().min(1), type: cardTypeSchema, parent: z.string().nullable(), status: cardStatusSchema, title: z.string().min(1) });
export const analystIssueSchema: z.ZodType<import('./types.js').AnalystIssue> = z.object({ summary: z.string().min(1), severity: z.enum(analystIssueSeverityValues).optional(), evidence_path: z.string().optional() }).strict();
export const analystIssuesSchema = z.array(analystIssueSchema);
export const projectConfigSchema = z.object({ id: z.literal('project'), name: z.string().min(1), context: z.string(), goals_summary: z.string(), constraints: z.array(z.string()), planner_enabled: z.boolean(), created_at: z.string().datetime(), updated_at: z.string().datetime() });
export const processStatusSchema = z.enum(['running', 'exited', 'failed', 'killed']);
export const processRecordSchema = z.object({ id: z.string().min(1), card_id: z.string().min(1).nullable(), owner_id: z.string().min(1), command: z.string().min(1), command_hash: z.string().min(32), cwd: z.string().min(1), cwd_canonical: z.string().min(1), status: processStatusSchema, pid: z.number().int().nullable().optional(), started_at: z.string().datetime(), started_at_monotonic: z.number().finite(), completed_at: z.string().datetime().nullable().optional(), exit_code: z.number().int().nullable().optional(), signal: z.string().nullable().optional(), terminal_reason: z.enum(['exit', 'signal', 'spawn_error']).nullable().optional(), required_for_card_completion: z.boolean(), output_dir: z.string().min(1), stdout_path: z.string().min(1), stderr_path: z.string().min(1), agent_session_id: z.string().nullable().optional(), goal_id: z.string().nullable().optional(), launch_reason: z.string().nullable().optional(), owner_kind: z.enum(['agent', 'operator', 'runtime']), background_policy: z.enum(['foreground']).nullable().optional(), failure_classification: z.enum(['spawn_error']).nullable().optional() }).strict();
export const agentRoleSchema = z.enum(agentRoleValues);
export const sessionStatusSchema = z.enum(['active', 'waiting', 'inactive', 'done', 'blocked', 'failed']);
export const agentSessionSchema = z.object({ id: z.string().min(1), role: agentRoleSchema, goal_card_id: z.string().nullable().optional(), card_id: z.string().nullable().optional(), assessment_id: z.string().nullable().optional(), status: sessionStatusSchema, started_at: z.string().datetime(), completed_at: z.string().datetime().nullable().optional(), model: z.string().optional() });
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export const messageKindSchema = z.enum(['text', 'activity', 'provider_exchange', 'tool_call', 'tool_result', 'tool_error', 'model_issue', 'model_repair', 'context_compaction', 'model_recovered', 'system_prompt']);
export const entityLinkSchema = z.object({ entity_type: z.enum(['card', 'process', 'artifact', 'attachment']), entity_id: z.string().min(1), label: z.string().optional() });
export const agentMessageSchema = z.object({ id: z.string().min(1), session_id: z.string().min(1), role: messageRoleSchema, kind: messageKindSchema, content: z.string(), round_id: z.string().regex(roundIdGrammar), message_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), block_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), tool: z.string().optional(), tool_call_id: z.string().optional(), timestamp: z.string().datetime(), links: z.array(entityLinkSchema).optional(), model_spec: z.string().optional(), requested_model_spec: z.string().optional() }).superRefine((message, ctx) => {
  if ((message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'tool_error') && message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_call_id must be a scalar string when present on tool entries', path: ['tool_call_id'] });
  if (message.kind !== 'tool_call' && message.kind !== 'tool_result' && message.kind !== 'tool_error') return;
  if (!message.tool) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${message.kind} rows require tool`, path: ['tool'] });
  if (!message.tool_call_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${message.kind} rows require tool_call_id`, path: ['tool_call_id'] });
    return;
  }
  try {
    if (message.kind === 'tool_call') sourceInputIdFromToolCallMessageId(message.id, message.tool_call_id);
    if (message.kind === 'tool_result') sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id);
    if (message.kind === 'tool_error') sourceInputIdFromToolErrorMessageId(message.id, message.tool_call_id);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ['id'] });
  }
});

export const activationCompletionOutcomeSchema = z.enum(['done', 'failed', 'blocked', 'cancelled', 'timed_out']);
export const activationCompletionEnvelopeV1Schema: z.ZodType<import('./types.js').ActivationCompletionEnvelopeV1> = z.object({ kind: z.literal('activate_card_completion'), version: z.literal(1), child_card_id: z.string().min(1), outcome: activationCompletionOutcomeSchema, summary: z.string(), result: z.record(z.string(), z.unknown()).nullable().optional(), evidence_card_ids: z.array(z.string()).optional(), error: z.string().nullable().optional(), completed_by_session_id: z.string().nullable().optional(), success: z.boolean(), cardId: z.string().min(1), failure_kind: z.string().optional() }).strict();

export function createActivationCompletionEnvelope(input: { child_card_id: string; outcome: import('./types.js').ActivationCompletionOutcome; summary: string; result?: Record<string, unknown> | null; evidence_card_ids?: string[]; error?: string | null; completed_by_session_id?: string | null; failure_kind?: string }): import('./types.js').ActivationCompletionEnvelopeV1 {
  const payload: import('./types.js').ActivationCompletionEnvelopeV1 = { kind: 'activate_card_completion', version: 1, child_card_id: input.child_card_id, outcome: input.outcome, summary: input.summary, result: input.result ?? null, evidence_card_ids: input.evidence_card_ids ?? [input.child_card_id], error: input.error ?? null, completed_by_session_id: input.completed_by_session_id ?? null, success: input.outcome !== 'failed', cardId: input.child_card_id };
  if (input.failure_kind) payload.failure_kind = input.failure_kind;
  return activationCompletionEnvelopeV1Schema.parse(payload);
}

export function parseActivationCompletionEnvelope(value: unknown): import('./types.js').ActivationCompletionEnvelopeV1 | null {
  const raw = typeof value === 'string' ? safeParseJson(value) : value;
  const parsed = activationCompletionEnvelopeV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function safeParseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
export const runtimeStatusSchema = z.enum(['stopped', 'running', 'paused', 'error']);
export const runtimeRunStatusSchema = z.enum(['stopped', 'running', 'paused', 'error', 'cancelled']);
export const activeCardRunRuntimeStatusSchema = z.literal('running');
export const runtimeDispatchOwnershipSchema: z.ZodType<import('./types.js').RuntimeDispatchOwnership> = z.union([
  z.object({ kind: z.literal('direct'), source: z.enum(['project_root', 'operator', 'startup_repair']) }).strict(),
  z.object({ kind: z.literal('activation'), parent_card_id: z.string().min(1), parent_tool_call: z.object({ session_id: z.string().min(1), source_input_id: z.string().min(1), tool_call_id: z.string().min(1) }).strict() }).strict(),
]);
export const actionableErrorEnvelopeSchema: z.ZodType<import('./types.js').ActionableErrorEnvelope> = z.object({ code: z.string().min(1), message: z.string().min(1), acceptedValues: z.array(z.string()).optional(), currentState: z.record(z.string(), z.unknown()).optional(), nextAction: z.string().min(1), docsRef: z.string().optional(), runId: z.string().nullable().optional(), sessionId: z.string().nullable().optional(), cardId: z.string().nullable().optional(), parentCardId: z.string().nullable().optional(), childCardId: z.string().nullable().optional() }).strict();
export function createActionableErrorEnvelope(input: import('./types.js').ActionableErrorEnvelope): import('./types.js').ActionableErrorEnvelope { return actionableErrorEnvelopeSchema.parse(input); }
export function actionableEnumError(field: string, value: unknown, acceptedValues: readonly string[], docsRef = 'docs/v3-planner-control-mcp-contract.md'): import('./types.js').ActionableErrorEnvelope { return createActionableErrorEnvelope({ code: 'invalid_enum_value', message: `Invalid ${field} '${String(value)}'. Accepted values: ${acceptedValues.join(', ')}.`, acceptedValues: [...acceptedValues], currentState: { field, value }, nextAction: `Retry with one of: ${acceptedValues.join(', ')}.`, docsRef }); }
export const activeCardRunSchema: z.ZodType<import('./types.js').ActiveCardRun> = z.object({ card_id: z.string().min(1), card_type: cardTypeSchema, ownership: runtimeDispatchOwnershipSchema, runtime_status: activeCardRunRuntimeStatusSchema, phase: z.enum(['planner', 'executor', 'reviewer']), caller_session_id: z.string().nullable(), caller_tool_call_id: z.string().nullable(), planner_session_id: z.string().nullable().optional(), executor_session_id: z.string().nullable().optional(), reviewer_session_id: z.string().nullable().optional(), correction_attempts: z.number().int().nonnegative(), started_at: z.string().datetime(), last_turn_at: z.string().datetime() });
export const runtimeStateSchema = z.object({ status: runtimeStatusSchema, project_id: z.literal('project'), pid: z.number().int().positive(), started_at: z.string().datetime(), active_card_run: activeCardRunSchema.nullable(), updated_at: z.string().datetime(), last_tick_at: z.string().datetime().nullable().optional() }).strict();
export const handoffSummarySchema = z.object({ session_id: z.string().min(1), role: agentRoleSchema, last_action: z.string(), next_action: z.string(), context_summary: z.string() });
export const sourceKindSchema = z.enum(['command_output', 'file', 'download', 'web', 'api', 'tool']);
export const reviewStatusSchema = z.enum(['passed', 'blocked', 'sanitized']);
export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export const contentReviewSchema = z.object({ id: z.string().min(1), source_kind: sourceKindSchema, source_ref: z.string().min(1), status: reviewStatusSchema, summary: z.string(), risk: riskLevelSchema, created_at: z.string().datetime() }).strict();
export const triggerTypeSchema = z.enum(['keyword', 'tool', 'path', 'tag']);
export const skillTriggerSchema = z.object({ type: triggerTypeSchema, pattern: z.string().min(1) });
export const skillIndexEntrySchema = z.object({ name: z.string().min(1), file: z.string().min(1), target_agents: z.array(agentRoleSchema), triggers: z.array(skillTriggerSchema), updated_at: z.string().datetime() });
export const skillIndexSchema = z.array(skillIndexEntrySchema);


export const runtimeEventKindSchema = enumFromCatalog(runtimeEventKindValues);
export const agentEventKindSchema = enumFromCatalog(agentEventKindValues);
export const eventKindSchema = enumFromCatalog(eventKindValues);

export const loggedEventSchemaByKind = Object.fromEntries(
  eventKindValues.map((kind) => [kind, buildLoggedEventSchema(kind)]),
) as Record<EventKind, z.ZodTypeAny>;

const loggedEventSchemaMembers = eventKindValues.map((kind) => loggedEventSchemaByKind[kind]) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
export const loggedEventSchema: z.ZodType<LoggedEvent> = z.union(loggedEventSchemaMembers) as z.ZodType<LoggedEvent>;
