import { z } from 'zod';

export type SeverityLevel = 'info' | 'warning' | 'error';
export type OutboundPolicy = 'internal' | 'operator' | 'audit';

const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const anyRecord = z.record(z.string(), z.unknown());

const agentRoleSchema = z.enum(['planner', 'executor', 'reviewer', 'manager', 'researcher', 'coder', 'tester', 'ux', 'critic']);
const runtimeRecordSchema = anyRecord;
const actionableErrorEnvelopeSchema = anyRecord;
const projectRunCompletedSchema = z.object({ project_card_id: z.string().optional(), result: z.enum(['done', 'failed', 'blocked']).optional(), summary: z.string().optional(), failure_kind: z.string().optional(), blocked_reason: z.string().optional() }).passthrough();

export const EventRegistry = {
  process_reconciled_dead: { schema: payload({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), probe_status: z.enum(['not_running', 'identity_mismatch', 'clock_skew']), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), detail: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  process_reattach_rejected: { schema: payload({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), reattach_error: z.string(), detail: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_report_rejected: { schema: payload({ goal_id: z.string().optional(), reason: z.string().optional(), reviewer_summary: z.string().optional(), missing: z.array(z.string()).optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  started: { schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_completed: { schema: payload({ goal_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_failed: { schema: payload({ goal_id: z.string(), error_message: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  review_complete: { schema: payload({ goal_id: z.string(), assessment: z.unknown().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  review_failed: { schema: payload({ goal_id: z.string(), assessment: z.unknown().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  shutdown: { schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  paused: { schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  resumed: { schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  card_failed: { schema: payload({ card_id: z.string().optional(), goal_id: z.string().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  escalation: { schema: payload({ goal_id: z.string(), reason: z.string().optional(), message: z.string().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  plan_updated: { schema: payload({ goal_id: z.string(), changes: z.array(z.string()).optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  dispatch_blocked: { schema: payload({ reason: z.string(), goal_id: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  dispatch_interrupted: { schema: payload({ goal_id: z.string(), reason: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  dispatch_held_for_notification: { schema: payload({ session_id: z.string(), role: z.enum(['executor', 'reviewer']), notification_ids: z.array(z.string()) }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_diagnostic: { schema: payload({ goal_id: z.string().optional(), card_id: z.string().optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_actionable_error: { schema: payload({ actionable_error: actionableErrorEnvelopeSchema }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_fatal_error: { schema: payload({ phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  subscriber_error: { schema: payload({ subscription_id: z.string(), source_kind: z.string(), error_message: z.string(), error_name: z.string().optional(), timed_out: z.boolean().optional() }), severity: 'error', tracked: false, audit: false, broadcast: false, outbound: 'internal' },
  stuck_supervisor_started: { schema: payload({ interval_ms: z.number(), consecutive_threshold: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  stuck_supervisor_stopped: { schema: payload({ checks_performed: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  stuck_verdict: { schema: payload({ verdict: z.boolean(), confidence: z.number(), reason: z.string(), evidence: z.array(z.string()), consecutive_count: z.number(), threshold: z.number() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  abort_target_selected: { schema: payload({ target_role: z.string(), target_session_id: z.string(), reason: z.string(), consecutive_count: z.number() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  force_cancel_sent: { schema: payload({ target_role: z.string(), target_session_id: z.string(), reason: z.string() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  project_run_completed: { schema: projectRunCompletedSchema, severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_command: { schema: payload({ command: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_run: { schema: payload({ run: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_activation: { schema: payload({ activation: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  frozen: { schema: payload({ freeze_id: z.string(), reason: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  resumed_from_freeze: { schema: payload({ freeze_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_started: { schema: payload({ session_id: z.string(), role: agentRoleSchema, goal_id: z.string(), card_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  model_selected: { schema: payload({ session_id: z.string(), provider: z.string(), model: z.string(), role: agentRoleSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  invocation_succeeded: { schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), duration_ms: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  invocation_failed: { schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), error_message: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  retry_attempted: { schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), directive: z.string().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  compaction_triggered: { schema: payload({ session_id: z.string(), role: agentRoleSchema, tokens_before: z.number(), tokens_after: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  self_check_triggered: { schema: payload({ session_id: z.string(), role: agentRoleSchema, rounds: z.number(), threshold: z.number(), response: z.string().nullable().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  model_issue: { schema: payload({ session_id: z.string(), role: agentRoleSchema.optional(), message: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_cancelled: { schema: payload({ session_id: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_force_cancelled: { schema: payload({ session_id: z.string() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  mcp_tool_invocation: { schema: payload({ session_id: z.string(), role: agentRoleSchema, server_name: z.string(), tool_name: z.string(), success: z.boolean(), error_message: z.string().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  card_history_appended: { schema: payload({ card_id: z.string(), version_seq: z.number(), changed_fields: z.array(z.string()), changed_at: z.string() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  notification_added: { schema: payload({ id: z.string(), kind: z.string(), severity: z.string(), related_card_id: z.string().optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional(), related_version_seq: z.number().optional(), created_at: z.string() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  notification_acknowledged: { schema: payload({ id: z.string(), kind: z.string(), related_card_id: z.string().optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional(), acknowledged_at: z.string() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  control_action_recorded: { schema: payload({ id: z.string(), action: z.string(), target_kind: z.string().nullable(), target_id: z.string().nullable(), outcome: z.string(), created_at: z.string(), actor: z.string().optional(), surface: z.string().optional() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  analyst_tool_invoked: { schema: payload({ sessionId: z.string(), tool: z.string(), success: z.boolean(), summary: z.string(), classified_as: z.string().optional(), related_card_id: z.string().optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
} as const satisfies Record<string, { schema: z.ZodTypeAny; severity: SeverityLevel; tracked: boolean; audit: boolean; broadcast: boolean; outbound: OutboundPolicy }>;

export type EventKind = keyof typeof EventRegistry;
export type EventPayload<K extends EventKind> = z.infer<(typeof EventRegistry)[K]['schema']>;
export type EventSeverity<K extends EventKind = EventKind> = (typeof EventRegistry)[K]['severity'];
export const eventKindValues = Object.keys(EventRegistry) as EventKind[];
export const runtimeEventKindValues = eventKindValues.filter((kind) => !kind.startsWith('session_') && !['model_selected', 'invocation_succeeded', 'invocation_failed', 'retry_attempted', 'compaction_triggered', 'self_check_triggered', 'model_issue', 'mcp_tool_invocation'].includes(kind)) as EventKind[];
export const agentEventKindValues = eventKindValues.filter((kind) => ['session_started', 'model_selected', 'invocation_succeeded', 'invocation_failed', 'retry_attempted', 'compaction_triggered', 'self_check_triggered', 'model_issue', 'session_cancelled', 'session_force_cancelled', 'mcp_tool_invocation'].includes(kind)) as EventKind[];
export const trackedEventKindValues = eventKindValues.filter((kind) => EventRegistry[kind].tracked);
export const broadcastEventKindValues = eventKindValues.filter((kind) => EventRegistry[kind].broadcast);
export const operatorBroadcastEventKindValues = eventKindValues.filter((kind) => EventRegistry[kind].broadcast && EventRegistry[kind].outbound === 'operator') as EventKind[];
export type OperatorBroadcastEventKind = typeof operatorBroadcastEventKindValues[number];

export function isOperatorBroadcastEventKind(kind: string): kind is OperatorBroadcastEventKind {
  return (operatorBroadcastEventKindValues as readonly string[]).includes(kind);
}

export function getEventSeverity(kind: EventKind): SeverityLevel {
  return EventRegistry[kind].severity;
}

export function buildLoggedEventSchema<K extends EventKind>(kind: K): z.ZodTypeAny {
  const base = z.object({
    id: z.string().min(1),
    kind: z.literal(kind),
    timestamp: z.string().datetime(),
    session_id: z.string().optional(),
    goal_id: z.string().optional(),
    card_id: z.string().optional(),
  });
  const { kind: _payloadKind, id: _payloadId, timestamp: _payloadTimestamp, ...payloadShape } = (EventRegistry[kind].schema as z.AnyZodObject).shape;
  return base.extend(payloadShape).passthrough();
}
