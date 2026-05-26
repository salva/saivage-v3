import { z } from 'zod';

export type SeverityLevel = 'info' | 'warning' | 'error';
export type OutboundPolicy = 'internal' | 'operator' | 'audit';
export type EventDomain = 'runtime' | 'agent';

const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const anyRecord = z.record(z.string(), z.unknown());

const agentRoleSchema = z.enum(['planner', 'executor', 'reviewer', 'manager', 'researcher', 'coder', 'tester', 'ux', 'critic']);
const runtimeRecordSchema = anyRecord;
const actionableErrorEnvelopeSchema = anyRecord;
const projectRunCompletedSchema = z.object({ project_card_id: z.string().optional(), result: z.enum(['done', 'failed', 'blocked']).optional(), summary: z.string().optional(), failure_kind: z.string().optional(), blocked_reason: z.string().optional() }).passthrough();

export const EventRegistry = {
  process_reconciled_dead: { domain: 'runtime', schema: payload({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), probe_status: z.enum(['not_running', 'identity_mismatch', 'clock_skew']), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), detail: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  process_reattach_rejected: { domain: 'runtime', schema: payload({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), reattach_error: z.string(), detail: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_report_rejected: { domain: 'runtime', schema: payload({ goal_id: z.string().optional(), reason: z.string().optional(), reviewer_summary: z.string().optional(), missing: z.array(z.string()).optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  started: { domain: 'runtime', schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_completed: { domain: 'runtime', schema: payload({ goal_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  goal_failed: { domain: 'runtime', schema: payload({ goal_id: z.string(), error_message: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  review_complete: { domain: 'runtime', schema: payload({ goal_id: z.string(), assessment: z.unknown().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  review_failed: { domain: 'runtime', schema: payload({ goal_id: z.string(), assessment: z.unknown().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  shutdown: { domain: 'runtime', schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  paused: { domain: 'runtime', schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  resumed: { domain: 'runtime', schema: payload({}), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  card_failed: { domain: 'runtime', schema: payload({ card_id: z.string().optional(), goal_id: z.string().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  escalation: { domain: 'runtime', schema: payload({ goal_id: z.string(), reason: z.string().optional(), message: z.string().optional() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  plan_updated: { domain: 'runtime', schema: payload({ goal_id: z.string(), changes: z.array(z.string()).optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  dispatch_blocked: { domain: 'runtime', schema: payload({ reason: z.string(), goal_id: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  dispatch_interrupted: { domain: 'runtime', schema: payload({ goal_id: z.string(), reason: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_diagnostic: { domain: 'runtime', schema: payload({ goal_id: z.string().optional(), card_id: z.string().optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_actionable_error: { domain: 'runtime', schema: payload({ actionable_error: actionableErrorEnvelopeSchema }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_fatal_error: { domain: 'runtime', schema: payload({ phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  startup_session_sweep: { domain: 'runtime', schema: payload({ swept_session_ids: z.array(z.string()) }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  subscriber_error: { domain: 'runtime', schema: payload({ subscription_id: z.string(), source_kind: z.string(), error_message: z.string(), error_name: z.string().optional(), timed_out: z.boolean().optional() }), severity: 'error', tracked: false, audit: false, broadcast: false, outbound: 'internal' },
  stuck_supervisor_started: { domain: 'runtime', schema: payload({ interval_ms: z.number(), consecutive_threshold: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  stuck_supervisor_stopped: { domain: 'runtime', schema: payload({ checks_performed: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  stuck_verdict: { domain: 'runtime', schema: payload({ verdict: z.boolean(), confidence: z.number(), reason: z.string(), evidence: z.array(z.string()), consecutive_count: z.number(), threshold: z.number() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  abort_target_selected: { domain: 'runtime', schema: payload({ target_role: z.string(), target_session_id: z.string(), reason: z.string(), consecutive_count: z.number() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  force_cancel_sent: { domain: 'runtime', schema: payload({ target_role: z.string(), target_session_id: z.string(), reason: z.string() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  project_run_completed: { domain: 'runtime', schema: projectRunCompletedSchema, severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_command: { domain: 'runtime', schema: payload({ command: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_run: { domain: 'runtime', schema: payload({ run: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  runtime_activation: { domain: 'runtime', schema: payload({ activation: runtimeRecordSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  frozen: { domain: 'runtime', schema: payload({ freeze_id: z.string(), reason: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  resumed_from_freeze: { domain: 'runtime', schema: payload({ freeze_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_started: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, goal_id: z.string(), card_id: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  model_selected: { domain: 'agent', schema: payload({ session_id: z.string(), provider: z.string(), model: z.string(), role: agentRoleSchema }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  invocation_succeeded: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), duration_ms: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  invocation_failed: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), error_message: z.string() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  retry_attempted: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, attempt: z.number(), directive: z.string().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  compaction_triggered: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, tokens_before: z.number(), tokens_after: z.number() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  self_check_triggered: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, rounds: z.number(), threshold: z.number(), response: z.string().nullable().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  model_issue: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema.optional(), message: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_cancelled: { domain: 'agent', schema: payload({ session_id: z.string() }), severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  session_force_cancelled: { domain: 'agent', schema: payload({ session_id: z.string() }), severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  mcp_tool_invocation: { domain: 'agent', schema: payload({ session_id: z.string(), role: agentRoleSchema, server_name: z.string(), tool_name: z.string(), success: z.boolean(), error_message: z.string().optional() }), severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  card_history_appended: { domain: 'runtime', schema: payload({ entry_id: z.string().uuid(), entry_kind: z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']), card_id: z.string(), version_seq: z.number(), changed_fields: z.array(z.string()), changed_at: z.string() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  notification_added: { domain: 'runtime', schema: payload({ session_id: z.string().nullable(), kind: z.string() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  control_action_recorded: { domain: 'runtime', schema: payload({ id: z.string(), action: z.string(), target_kind: z.string().nullable(), target_id: z.string().nullable(), outcome: z.string(), created_at: z.string(), actor: z.string().optional(), surface: z.string().optional() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  analyst_tool_invoked: { domain: 'runtime', schema: payload({ sessionId: z.string(), tool: z.string(), success: z.boolean(), summary: z.string(), classified_as: z.string().optional(), related_card_id: z.string().optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional() }), severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' },
  control_action_record_appended: { domain: 'runtime', schema: payload({ record: anyRecord }), severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' },
  event_log_record_appended: { domain: 'runtime', schema: payload({ record: anyRecord }), severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' },
  error_log_record_appended: { domain: 'runtime', schema: payload({ record: anyRecord }), severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' },
} as const satisfies Record<string, { domain: EventDomain; schema: z.ZodTypeAny; severity: SeverityLevel; tracked: boolean; audit: boolean; broadcast: boolean; outbound: OutboundPolicy }>;

export type EventKind = keyof typeof EventRegistry;
export type EventPayload<K extends EventKind> = z.infer<(typeof EventRegistry)[K]['schema']>;
export type EventSeverity<K extends EventKind = EventKind> = (typeof EventRegistry)[K]['severity'];
export const eventKindValues = Object.keys(EventRegistry) as EventKind[];
export const runtimeEventKindValues = eventKindValues.filter((kind) => EventRegistry[kind].domain === 'runtime') as EventKind[];
export const agentEventKindValues = eventKindValues.filter((kind) => EventRegistry[kind].domain === 'agent') as EventKind[];
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
  const { kind: _payloadKind, id: _payloadId, timestamp: _payloadTimestamp, ...payloadShape } = (EventRegistry[kind].schema as z.AnyZodObject).shape; void _payloadKind; void _payloadId; void _payloadTimestamp;
  return base.extend(payloadShape).passthrough();
}
