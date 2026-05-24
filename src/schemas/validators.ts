import { z } from 'zod';
import {
  agentEventKindValues,
  eventKindValues,
  runtimeEventKindValues,
  type EventKind,
  type LoggedEvent,
} from './types.js';
import { buildLoggedEventSchema } from '../events/index.js';


export const cardTypeSchema = z.enum(['project','goal','architecture','code','test','doc','data','research','ops']);
export const cardStatusSchema = z.enum(['drafting','backlog','active','running','blocked','changed','done','failed','cancelled','needs_verification']);
export const cardActionSchema = z.enum(['card.start','card.cancel','card.delete','card.restart']);
export const urgencySchema = z.enum(['low', 'normal', 'high', 'critical']);
export const createdBySchema = z.enum(['user', 'analyst', 'planner']);
export const noteAuthorSchema = z.enum(['user', 'analyst', 'planner', 'executor', 'reviewer', 'runtime']);
export const controlActionSurfaceSchema = z.enum(['web-chat', 'telegram', 'rest', 'cli', 'runtime', 'web-ui']);
export const artifactRefSchema = z.object({ id: z.string().min(1), card_id: z.string().min(1), path: z.string().min(1), type: z.enum(['model', 'data', 'config', 'log', 'report', 'other']), description: z.string(), retain: z.boolean(), created_at: z.string().datetime() });
export const attachmentRefSchema = z.object({ id: z.string().min(1), card_id: z.string().min(1), path: z.string().min(1), mime: z.string().min(1), title: z.string().min(1), description: z.string().optional(), created_at: z.string().datetime() });
export const cardMetadataSchema: z.ZodType<import('./types.js').CardMetadata> = z.object({ max_review_retries: z.number().int().nonnegative().optional() }).catchall(z.unknown());
export const cardRecordSchema: z.ZodType<import('./types.js').CardRecord> = z.lazy(() => z.object({ id: z.string().min(1), type: cardTypeSchema, parent: z.string().nullable(), depth: z.number().int().min(0), title: z.string().min(1), description: z.string(), status: cardStatusSchema, planner_state: cardStatusSchema.optional(), plannerState: cardStatusSchema.optional(), subtype: z.string().nullable().optional(), instructions_file: z.string().nullable().optional(), tags: z.array(z.string()), priority: z.number().int(), urgency: urgencySchema, created_by: createdBySchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), version_seq: z.number().int().positive(), assigned_to: z.string().nullable().optional(), depends_on: z.array(z.string()), blocks: z.array(z.string()), related: z.array(z.string()), acceptance: z.string(), result: z.record(z.string(), z.unknown()).nullable().optional(), metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).nullable().optional(), artifacts: z.array(artifactRefSchema), attachments: z.array(attachmentRefSchema), estimate: z.string().nullable().optional(), started_at: z.string().datetime().nullable().optional(), completed_at: z.string().datetime().nullable().optional(), duration_ms: z.number().int().nonnegative().nullable().optional(), error: z.string().nullable().optional(), status_text: z.string().nullable().optional(), status_text_updated_at: z.string().datetime().nullable().optional(), status_text_author_session_id: z.string().nullable().optional(), latest_self_report: z.record(z.string(), z.unknown()).nullable().optional(), metadata: cardMetadataSchema.nullable().optional(), allowedActions: z.array(cardActionSchema).optional(), retries: z.number().int().nonnegative() }));
export const cardHistoryKindSchema = z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']);
const cardHistoryEntryBaseSchema = z.object({ entry_id: z.string().uuid(), kind: cardHistoryKindSchema, card_id: z.string().min(1), version_seq: z.number().int().positive(), snapshot: cardRecordSchema, changed_at: z.string().datetime(), changed_by_actor: noteAuthorSchema, changed_by_surface: controlActionSurfaceSchema, change_reason: z.string().nullable(), changed_fields: z.array(z.string()), change_summary: z.string() });
export const cardHistoryHeaderSchema: z.ZodType<import('./types.js').CardHistoryHeader> = cardHistoryEntryBaseSchema.omit({ snapshot: true });
export const cardHistoryEntrySchema: z.ZodType<import('./types.js').CardHistoryEntry> = cardHistoryEntryBaseSchema;
export const notificationRecordSchema: z.ZodType<import('./types.js').NotificationRecord> = z.object({ id: z.string().min(1), session_id: z.string().nullable(), kind: z.enum(['card_changed', 'note_added', 'process_state', 'runtime_state', 'config_changed']), severity: z.enum(['info', 'warn', 'block']), payload_summary: z.string().min(1), related_card_id: z.string().min(1).optional(), related_note_id: z.string().min(1).optional(), related_process_id: z.string().min(1).optional(), related_version_seq: z.number().int().positive().optional(), source_actor: noteAuthorSchema, source_surface: controlActionSurfaceSchema, created_at: z.string().datetime(), delivered_at: z.string().datetime().nullable(), acknowledged_at: z.string().datetime().nullable() });
export const controlActionAuditEntrySchema: z.ZodType<import('./types.js').ControlActionAuditEntry> = z.object({ id: z.string().min(1), actor: noteAuthorSchema, surface: controlActionSurfaceSchema, action: z.string().min(1), target_kind: z.enum(['card', 'note', 'process', 'runtime', 'config', 'session']).nullable(), target_id: z.string().nullable(), params_summary: z.string(), confirmed: z.boolean(), outcome: z.enum(['ok', 'error', 'denied', 'rejected', 'preview']), outcome_summary: z.string(), error: z.string().optional(), created_at: z.string().datetime() });
export const cardIndexEntrySchema = z.object({ id: z.string().min(1), type: cardTypeSchema, parent: z.string().nullable(), status: cardStatusSchema, title: z.string().min(1) });
export const reviewerIssueSchema: z.ZodType<import('./types.js').ReviewerIssue> = z.object({ summary: z.string(), severity: z.enum(['info', 'warning', 'blocker']), evidence_card_id: z.string().optional(), recommendation: z.string().optional() }).strict();
const reviewerResultBaseSchema = z.object({ result: z.enum(['pass', 'needs_corrections']), summary: z.string(), achieved: z.array(z.string()), issues: z.array(reviewerIssueSchema), evidence_card_ids: z.array(z.string()) }).strict();
export const reviewerResultSchema: z.ZodType<import('./types.js').ReviewerResult> = reviewerResultBaseSchema;
export const reviewAssessmentSchema: z.ZodType<import('./types.js').ReviewAssessment> = reviewerResultBaseSchema.extend({ assessment_id: z.string().min(1), at: z.string().datetime(), reviewer_session_id: z.string().optional(), goal_card_id: z.string().optional(), id: z.string().optional(), created_at: z.string().datetime().optional() }).strict();
export const projectConfigSchema = z.object({ id: z.literal('project'), name: z.string().min(1), context: z.string(), goals_summary: z.string(), constraints: z.array(z.string()), max_goal_depth: z.number().int().min(0), planner_enabled: z.boolean(), created_at: z.string().datetime(), updated_at: z.string().datetime() });
export const diaryKindSchema = z.enum(['planner_invocation', 'planner_decision', 'card_mutation', 'review_assessment', 'failure_handling']);
export const diaryEntrySchema = z.object({ id: z.string().min(1), goal_card_id: z.string().min(1), invocation_id: z.string().min(1), kind: diaryKindSchema, timestamp: z.string().datetime(), input_summary: z.string().optional(), decision: z.string().optional(), rationale: z.string().optional(), created_cards: z.array(z.string()).optional(), updated_cards: z.array(z.string()).optional(), reviewed_cards: z.array(z.string()).optional(), assessment: reviewAssessmentSchema.optional(), raw: z.record(z.string(), z.unknown()).optional() });
export const noteKindSchema = z.enum(['comment', 'progress', 'directive', 'escalation']);
export const noteRecordSchema = z.object({ id: z.string().min(1), card_id: z.string().min(1), author: noteAuthorSchema, timestamp: z.string().datetime(), content: z.string(), kind: noteKindSchema, handled: z.boolean(), handled_at: z.string().datetime().nullable().optional() });
export const notesQueueEntrySchema = z.object({ card_id: z.string().min(1), note_id: z.string().min(1), timestamp: z.string().datetime(), kind: noteKindSchema });
export const notesQueueSchema = z.object({ next_note_sequence: z.number().int().positive(), entries: z.array(notesQueueEntrySchema) });
export const processStatusSchema = z.enum(['running', 'exited', 'failed', 'killed']);
export const processRecordSchema = z.object({ id: z.string().min(1), card_id: z.string().min(1), command: z.string().min(1), command_hash: z.string().min(32), cwd: z.string().min(1), cwd_canonical: z.string().min(1), status: processStatusSchema, pid: z.number().int().nullable().optional(), started_at: z.string().datetime(), started_at_monotonic: z.number().finite(), completed_at: z.string().datetime().nullable().optional(), exit_code: z.number().int().nullable().optional(), signal: z.string().nullable().optional(), terminal_reason: z.enum(['exit', 'signal', 'spawn_error', 'lost', 'kill_unattached']).nullable().optional(), required_for_card_completion: z.boolean(), output_dir: z.string().min(1), stdout_path: z.string().min(1), stderr_path: z.string().min(1), combined_log_path: z.string().min(1), agent_session_id: z.string().nullable().optional(), goal_id: z.string().nullable().optional(), launch_reason: z.string().nullable().optional(), owner_kind: z.enum(['agent', 'operator', 'runtime']).nullable().optional(), background_policy: z.enum(['foreground']).nullable().optional(), process_group_id: z.number().int().nonnegative().nullable().optional(), reattach_state: z.enum(['attached', 'reattached', 'lost']).nullable().optional(), failure_classification: z.enum(['lost', 'spawn_error']).nullable().optional(), reattach_error: z.string().nullable().optional() });
export const agentRoleSchema = z.enum(['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor']);
export const sessionStatusSchema = z.enum(['active', 'waiting', 'inactive', 'done', 'blocked', 'failed']);
export const agentSessionSchema = z.object({ id: z.string().min(1), role: agentRoleSchema, goal_card_id: z.string().nullable().optional(), card_id: z.string().nullable().optional(), status: sessionStatusSchema, started_at: z.string().datetime(), completed_at: z.string().datetime().nullable().optional(), model: z.string().optional() });
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export const messageKindSchema = z.enum(['text', 'activity', 'tool_call', 'tool_result', 'tool_error', 'model_issue', 'model_repair', 'model_recovered']);
export const entityLinkSchema = z.object({ entity_type: z.enum(['card', 'process', 'artifact', 'attachment', 'quarantine']), entity_id: z.string().min(1), label: z.string().optional() });
export const agentMessageSchema = z.object({ id: z.string().min(1), session_id: z.string().min(1), role: messageRoleSchema, kind: messageKindSchema, content: z.string(), tool: z.string().optional(), tool_call_id: z.string().optional(), timestamp: z.string().datetime(), links: z.array(entityLinkSchema).optional() });

export const deferredActivationEnvelopeV1Schema: z.ZodType<import('./types.js').DeferredActivationEnvelopeV1> = z.object({ kind: z.literal('deferred_activate_card'), version: z.literal(1), parent_card_id: z.string().min(1), child_card_id: z.string().min(1), planner_session_id: z.string().min(1), tool_call_id: z.string().min(1), requested_at: z.string().datetime() }).strict();
export const activationCompletionOutcomeSchema = z.enum(['done', 'failed', 'blocked', 'cancelled', 'timed_out', 'needs_verification']);
export const activationCompletionEnvelopeV1Schema: z.ZodType<import('./types.js').ActivationCompletionEnvelopeV1> = z.object({ kind: z.literal('activate_card_completion'), version: z.literal(1), child_card_id: z.string().min(1), outcome: activationCompletionOutcomeSchema, summary: z.string(), result: z.record(z.string(), z.unknown()).nullable().optional(), review: z.lazy(() => reviewAssessmentSchema).nullable().optional(), artifacts: z.array(artifactRefSchema).optional(), attachments: z.array(attachmentRefSchema).optional(), evidence_card_ids: z.array(z.string()).optional(), error: z.string().nullable().optional(), completed_by_session_id: z.string().nullable().optional(), success: z.boolean(), cardId: z.string().min(1), failure_kind: z.string().optional() }).strict();


export function createDeferredActivationEnvelope(input: { parent_card_id: string; child_card_id: string; planner_session_id: string; tool_call_id: string; requested_at?: string }): import('./types.js').DeferredActivationEnvelopeV1 {
  return deferredActivationEnvelopeV1Schema.parse({ kind: 'deferred_activate_card', version: 1, parent_card_id: input.parent_card_id, child_card_id: input.child_card_id, planner_session_id: input.planner_session_id, tool_call_id: input.tool_call_id, requested_at: input.requested_at ?? new Date().toISOString() });
}

export function createActivationCompletionEnvelope(input: { child_card_id: string; outcome: import('./types.js').ActivationCompletionOutcome; summary: string; result?: Record<string, unknown> | null; review?: import('./types.js').ReviewAssessment | null; artifacts?: import('./types.js').ArtifactRef[]; attachments?: import('./types.js').AttachmentRef[]; evidence_card_ids?: string[]; error?: string | null; completed_by_session_id?: string | null; failure_kind?: string }): import('./types.js').ActivationCompletionEnvelopeV1 {
  const payload: import('./types.js').ActivationCompletionEnvelopeV1 = { kind: 'activate_card_completion', version: 1, child_card_id: input.child_card_id, outcome: input.outcome, summary: input.summary, result: input.result ?? null, review: input.review ?? null, artifacts: input.artifacts ?? [], attachments: input.attachments ?? [], evidence_card_ids: input.evidence_card_ids ?? [input.child_card_id], error: input.error ?? null, completed_by_session_id: input.completed_by_session_id ?? null, success: input.outcome !== 'failed', cardId: input.child_card_id };
  if (input.failure_kind) payload.failure_kind = input.failure_kind;
  return activationCompletionEnvelopeV1Schema.parse(payload);
}

export function parseDeferredActivationEnvelope(value: unknown): import('./types.js').DeferredActivationEnvelopeV1 | null {
  const raw = typeof value === 'string' ? safeParseJson(value) : value;
  const parsed = deferredActivationEnvelopeV1Schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).__saivage_defer_tool_result === true) {
    const child = (raw as Record<string, unknown>).child_card_id ?? (raw as Record<string, unknown>).cardId ?? (raw as Record<string, unknown>).card_id;
    if (typeof child === 'string' && child.length > 0) return { kind: 'deferred_activate_card', version: 1, parent_card_id: 'legacy', child_card_id: child, planner_session_id: 'legacy', tool_call_id: 'legacy', requested_at: new Date(0).toISOString() };
  }
  return null;
}

export function parseActivationCompletionEnvelope(value: unknown): import('./types.js').ActivationCompletionEnvelopeV1 | null {
  const raw = typeof value === 'string' ? safeParseJson(value) : value;
  const parsed = activationCompletionEnvelopeV1Schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const child = rec.child_card_id ?? rec.cardId ?? rec.card_id;
    const outcome = rec.outcome ?? (rec.success === true ? 'done' : rec.success === false ? 'failed' : undefined);
    if (typeof child === 'string' && child.length > 0 && typeof outcome === 'string' && activationCompletionOutcomeSchema.safeParse(outcome).success) {
      return createActivationCompletionEnvelope({ child_card_id: child, outcome: outcome as import('./types.js').ActivationCompletionOutcome, summary: typeof rec.summary === 'string' ? rec.summary : '', result: isRecord(rec.result) ? rec.result : null, review: rec.review as import('./types.js').ReviewAssessment | null | undefined, artifacts: Array.isArray(rec.artifacts) ? rec.artifacts as import('./types.js').ArtifactRef[] : [], attachments: Array.isArray(rec.attachments) ? rec.attachments as import('./types.js').AttachmentRef[] : [], evidence_card_ids: Array.isArray(rec.evidence_card_ids) ? rec.evidence_card_ids.map(String) : [child], error: typeof rec.error === 'string' ? rec.error : null, completed_by_session_id: typeof rec.completed_by_session_id === 'string' ? rec.completed_by_session_id : null, failure_kind: typeof rec.failure_kind === 'string' ? rec.failure_kind : undefined });
    }
  }
  return null;
}

export function parseActivationEnvelopeContent(content: string): { deferred: import('./types.js').DeferredActivationEnvelopeV1 | null; completion: import('./types.js').ActivationCompletionEnvelopeV1 | null } {
  return { deferred: parseDeferredActivationEnvelope(content), completion: parseActivationCompletionEnvelope(content) };
}

function safeParseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
export const runtimeStatusSchema = z.enum(['idle', 'running', 'paused', 'error', 'frozen']);
export const activeCardRunRuntimeStatusSchema = z.enum(['idle', 'running', 'paused', 'error', 'frozen', 'stopped', 'cancelled']);
export const runtimeIntentStatusSchema = z.enum(['running', 'stopped']);
export const runtimeCommandNameSchema = z.enum(['start_project', 'stop_project']);
export const runtimeCommandStatusSchema = z.enum(['accepted', 'rejected', 'completed']);
export const runtimeRunKindSchema = z.enum(['root', 'child']);
export const runtimeRunPhaseSchema = z.enum(['pending', 'planner', 'executor', 'reviewer', 'completed', 'failed', 'blocked', 'cancelled', 'stopped', 'needs_verification']);
export const runtimeActivationStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled', 'needs_verification']);
export const actionableErrorEnvelopeSchema: z.ZodType<import('./types.js').ActionableErrorEnvelope> = z.object({ code: z.string().min(1), message: z.string().min(1), acceptedValues: z.array(z.string()).optional(), currentState: z.record(z.string(), z.unknown()).optional(), nextAction: z.string().min(1), docsRef: z.string().optional(), runId: z.string().nullable().optional(), sessionId: z.string().nullable().optional(), cardId: z.string().nullable().optional(), parentCardId: z.string().nullable().optional(), childCardId: z.string().nullable().optional() }).strict();
export function createActionableErrorEnvelope(input: import('./types.js').ActionableErrorEnvelope): import('./types.js').ActionableErrorEnvelope { return actionableErrorEnvelopeSchema.parse(input); }
export function actionableEnumError(field: string, value: unknown, acceptedValues: readonly string[], docsRef = 'docs/v3-planner-control-mcp-contract.md'): import('./types.js').ActionableErrorEnvelope { return createActionableErrorEnvelope({ code: 'invalid_enum_value', message: `Invalid ${field} '${String(value)}'. Accepted values: ${acceptedValues.join(', ')}.`, acceptedValues: [...acceptedValues], currentState: { field, value }, nextAction: `Retry with one of: ${acceptedValues.join(', ')}.`, docsRef }); }
export const runtimeIntentSchema: z.ZodType<import('./types.js').RuntimeIntent> = z.object({ status: runtimeIntentStatusSchema, updated_at: z.string().datetime(), source_command_id: z.string().nullable(), reason: z.string().nullable().optional() }).strict();
export const runtimeCommandRecordSchema: z.ZodType<import('./types.js').RuntimeCommandRecord> = z.object({ command_id: z.string().min(1), command: runtimeCommandNameSchema, status: runtimeCommandStatusSchema, requested_at: z.string().datetime(), completed_at: z.string().datetime().nullable().optional(), source: z.enum(['operator', 'tool', 'runtime']), error: actionableErrorEnvelopeSchema.nullable().optional() }).strict();
export const runtimeRunRecordSchema: z.ZodType<import('./types.js').RuntimeRunRecord> = z.object({ run_id: z.string().min(1), kind: runtimeRunKindSchema, card_id: z.string().min(1), parent_run_id: z.string().nullable().optional(), command_id: z.string().nullable().optional(), activation_id: z.string().nullable().optional(), phase: runtimeRunPhaseSchema, runtime_status: activeCardRunRuntimeStatusSchema, session_id: z.string().nullable().optional(), started_at: z.string().datetime(), updated_at: z.string().datetime(), finished_at: z.string().datetime().nullable().optional(), result: z.enum(['done', 'failed', 'blocked', 'cancelled', 'stopped', 'needs_verification']).nullable().optional() }).strict();
export const runtimeActivationRecordSchema: z.ZodType<import('./types.js').RuntimeActivationRecord> = z.object({ activation_id: z.string().min(1), idempotency_key: z.string().min(1), parent_card_id: z.string().min(1), parent_run_id: z.string().min(1), parent_session_id: z.string().min(1), parent_tool_call_id: z.string().min(1), child_card_id: z.string().min(1), status: runtimeActivationStatusSchema, requested_at: z.string().datetime(), updated_at: z.string().datetime(), precondition: z.enum(['accepted', 'rejected']), runtime_run_id: z.string().nullable().optional(), error: actionableErrorEnvelopeSchema.nullable().optional() }).strict();
export const activeCardRunSchema: z.ZodType<import('./types.js').ActiveCardRun> = z.object({ card_id: z.string().min(1), card_type: cardTypeSchema, runtime_status: activeCardRunRuntimeStatusSchema, phase: z.enum(['planner', 'executor', 'reviewer']), caller_session_id: z.string().nullable(), caller_tool_call_id: z.string().nullable(), planner_session_id: z.string().nullable().optional(), executor_session_id: z.string().nullable().optional(), reviewer_session_id: z.string().nullable().optional(), correction_attempts: z.number().int().nonnegative(), started_at: z.string().datetime(), last_turn_at: z.string().datetime() });
export const runtimeStateSchema = z.object({ status: runtimeStatusSchema, project_id: z.literal('project'), started_at: z.string().datetime(), current_card_id: z.string().nullable().optional(), current_agent_session_id: z.string().nullable().optional(), active_card_run: activeCardRunSchema.nullable().optional(), paused: z.boolean(), paused_at: z.string().datetime().nullable().optional(), queue: z.array(z.string()), running_processes: z.array(z.string()), updated_at: z.string().datetime(), last_tick_at: z.string().datetime().nullable().optional(), frozen_reason: z.string().nullable().optional(), runtime_intent: runtimeIntentSchema, runtime_commands: z.array(runtimeCommandRecordSchema), runtime_runs: z.array(runtimeRunRecordSchema), runtime_activations: z.array(runtimeActivationRecordSchema) });
export const handoffSummarySchema = z.object({ session_id: z.string().min(1), role: agentRoleSchema, last_action: z.string(), next_action: z.string(), context_summary: z.string() });
export const freezeManifestSchema = z.object({ freeze_id: z.string().min(1), reason: z.string(), created_at: z.string().datetime(), status: z.literal('frozen'), project_id: z.literal('project'), pid: z.number().int().positive(), started_at: z.string().datetime(), current_card_id: z.string().nullable(), current_agent_session_id: z.string().nullable(), queue: z.array(z.string()), running_processes: z.array(z.string().min(1)), handoff_summaries: z.array(handoffSummarySchema), schema_version: z.number().int().positive(), runtime_version: z.string().min(1) });
export const sourceKindSchema = z.enum(['command_output', 'file', 'download', 'web', 'api', 'tool']);
export const reviewStatusSchema = z.enum(['passed', 'blocked', 'sanitized']);
export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export const contentReviewSchema = z.object({ id: z.string().min(1), source_kind: sourceKindSchema, source_ref: z.string().min(1), status: reviewStatusSchema, summary: z.string(), risk: riskLevelSchema, quarantine_id: z.string().nullable().optional(), created_at: z.string().datetime() });
export const quarantineItemSchema = z.object({ id: z.string().min(1), review_id: z.string().min(1), source_ref: z.string().min(1), stored_path: z.string().min(1), reason: z.string(), created_at: z.string().datetime() });
export const triggerTypeSchema = z.enum(['keyword', 'tool', 'path', 'tag']);
export const skillTriggerSchema = z.object({ type: triggerTypeSchema, pattern: z.string().min(1) });
export const skillIndexEntrySchema = z.object({ name: z.string().min(1), file: z.string().min(1), target_agents: z.array(agentRoleSchema), triggers: z.array(skillTriggerSchema), updated_at: z.string().datetime() });
export const skillIndexSchema = z.array(skillIndexEntrySchema);


function enumFromCatalog(values: readonly string[]) { return z.enum(values as unknown as [string, ...string[]]); }

export const runtimeEventKindSchema = enumFromCatalog(runtimeEventKindValues);
export const agentEventKindSchema = enumFromCatalog(agentEventKindValues);
export const eventKindSchema = enumFromCatalog(eventKindValues);
export const baseEventSchema = z.object({ id: z.string().min(1), kind: eventKindSchema, timestamp: z.string().datetime(), session_id: z.string().optional(), goal_id: z.string().optional(), card_id: z.string().optional() });
const passthroughBaseEventSchema = baseEventSchema.passthrough();
export const processReconciledDeadEventSchema = baseEventSchema.extend({ kind: z.literal('process_reconciled_dead'), process_id: z.string().min(1), card_id: z.string().min(1), goal_id: z.string().min(1).optional(), session_id: z.string().min(1).optional(), pid: z.number().int().nullable().optional(), probe_status: z.enum(['not_running', 'identity_mismatch', 'clock_skew']), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), detail: z.string().min(1) }).strict();
export const processReattachRejectedEventSchema = baseEventSchema.extend({ kind: z.literal('process_reattach_rejected'), process_id: z.string().min(1), card_id: z.string().min(1), goal_id: z.string().min(1).optional(), session_id: z.string().min(1).optional(), pid: z.number().int().nullable().optional(), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), reattach_error: z.string().min(1), detail: z.string().min(1) }).strict();
const eventEmbeddedAssessmentSchema = z.union([reviewAssessmentSchema, reviewerResultBaseSchema]);
export const goalReportRejectedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('goal_report_rejected'), goal_id: z.string().optional(), reason: z.string().optional(), reviewer_summary: z.string().optional(), missing: z.array(z.string()).optional() });
export const startedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('started'), project_root: z.string() });
export const goalCompletedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('goal_completed'), goal_id: z.string(), assessment: eventEmbeddedAssessmentSchema.optional() });
export const goalFailedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('goal_failed'), goal_id: z.string(), error_message: z.string().optional() });
export const cardFailedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('card_failed'), card_id: z.string(), goal_id: z.string() });
export const reviewCompleteEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('review_complete'), goal_id: z.string(), assessment: eventEmbeddedAssessmentSchema.optional() });
export const reviewFailedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('review_failed'), goal_id: z.string(), assessment: eventEmbeddedAssessmentSchema.optional() });
export const dispatchBlockedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('dispatch_blocked'), reason: z.string(), goal_id: z.string() });
export const dispatchInterruptedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('dispatch_interrupted'), goal_id: z.string(), reason: z.string() });
export const dispatchHeldForNotificationEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('dispatch_held_for_notification'), session_id: z.string(), role: z.enum(['executor', 'reviewer']), notification_ids: z.array(z.string()) });
export const escalationEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('escalation'), goal_id: z.string(), reason: z.string().optional(), message: z.string().optional() });
export const planUpdatedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('plan_updated'), goal_id: z.string(), changes: z.array(z.string()).optional() });
export const pausedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('paused') });
export const resumedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('resumed') });
export const shutdownEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('shutdown') });
export const runtimeDiagnosticEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('runtime_diagnostic'), goal_id: z.string().optional(), card_id: z.string().optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() });
export const projectRunCompletedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('project_run_completed'), project_card_id: z.string(), result: z.enum(['done', 'failed', 'blocked']), summary: z.string(), failure_kind: z.string().optional(), blocked_reason: z.string().optional() });
export const frozenEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('frozen'), freeze_id: z.string(), reason: z.string() });
export const resumedFromFreezeEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('resumed_from_freeze'), freeze_id: z.string() });
export const runtimeCommandEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('runtime_command'), command: runtimeCommandRecordSchema });
export const runtimeRunEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('runtime_run'), run: runtimeRunRecordSchema });
export const runtimeActivationEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('runtime_activation'), activation: runtimeActivationRecordSchema });
export const runtimeActionableErrorEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('runtime_actionable_error'), actionable_error: actionableErrorEnvelopeSchema });
export const stuckSupervisorStartedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('stuck_supervisor_started'), interval_ms: z.number(), consecutive_threshold: z.number() });
export const stuckSupervisorStoppedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('stuck_supervisor_stopped'), checks_performed: z.number() });
export const stuckVerdictEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('stuck_verdict'), verdict: z.boolean(), confidence: z.number(), reason: z.string(), evidence: z.array(z.string()), consecutive_count: z.number(), threshold: z.number() });
export const abortTargetSelectedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('abort_target_selected'), target_role: z.string(), target_session_id: z.string(), reason: z.string(), consecutive_count: z.number() });
export const forceCancelSentEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('force_cancel_sent'), target_role: z.string(), target_session_id: z.string(), reason: z.string() });
export const sessionStartedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('session_started'), session_id: z.string(), role: agentRoleSchema, goal_id: z.string(), card_id: z.string() });
export const modelSelectedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('model_selected'), session_id: z.string(), provider: z.string(), model: z.string(), role: agentRoleSchema });
export const invocationSucceededEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('invocation_succeeded'), session_id: z.string(), role: agentRoleSchema, attempt: z.number(), duration_ms: z.number() });
export const invocationFailedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('invocation_failed'), session_id: z.string(), role: agentRoleSchema, attempt: z.number(), error_message: z.string() });
export const retryAttemptedEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('retry_attempted'), session_id: z.string(), role: agentRoleSchema, attempt: z.number(), directive: z.string().optional() });
export const compactionTriggeredEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('compaction_triggered'), session_id: z.string(), role: agentRoleSchema, tokens_before: z.number(), tokens_after: z.number() });
export const selfCheckTriggeredEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('self_check_triggered'), session_id: z.string(), role: agentRoleSchema, rounds: z.number(), threshold: z.number(), response: z.string().nullable().optional() });
export const modelIssueEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('model_issue'), session_id: z.string(), role: agentRoleSchema.optional(), message: z.string() });
export const sessionCancelledEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('session_cancelled'), session_id: z.string() });
export const sessionForceCancelledEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('session_force_cancelled'), session_id: z.string() });
export const mcpToolInvocationEventSchema = passthroughBaseEventSchema.extend({ kind: z.literal('mcp_tool_invocation'), session_id: z.string(), role: agentRoleSchema, server_name: z.string(), tool_name: z.string(), success: z.boolean(), error_message: z.string().optional() });

export const loggedEventSchemaByKind = Object.fromEntries(
  eventKindValues.map((kind) => [kind, buildLoggedEventSchema(kind)]),
) as Record<EventKind, z.ZodTypeAny>;

const loggedEventSchemaMembers = eventKindValues.map((kind) => loggedEventSchemaByKind[kind]) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
export const loggedEventSchema: z.ZodType<LoggedEvent> = z.union(loggedEventSchemaMembers) as z.ZodType<LoggedEvent>;
export const loggedEventCompatibilitySchema = z.object({ id: z.string().min(1), kind: z.string().min(1), timestamp: z.string().datetime(), session_id: z.string().optional(), goal_id: z.string().optional(), card_id: z.string().optional() }).passthrough();
export type LoggedEventCompatResult = { ok: true; event: LoggedEvent; compatibility: 'strict' } | { ok: true; event: Record<string, unknown> & { id: string; kind: string; timestamp: string }; compatibility: 'unknown-kind'; warning: string } | { ok: false; error: z.ZodError };
export function parseLoggedEventCompat(value: unknown): LoggedEventCompatResult {
  const strict = loggedEventSchema.safeParse(value);
  if (strict.success) return { ok: true, event: strict.data, compatibility: 'strict' };
  const compat = loggedEventCompatibilitySchema.safeParse(value);
  if (!compat.success) return { ok: false, error: compat.error };
  if ((eventKindValues as readonly string[]).includes(compat.data.kind)) return { ok: false, error: strict.error };
  return { ok: true, event: compat.data as Record<string, unknown> & { id: string; kind: string; timestamp: string }, compatibility: 'unknown-kind', warning: `Unknown historical runtime event kind '${compat.data.kind}' accepted by compatibility parser.` };
}

