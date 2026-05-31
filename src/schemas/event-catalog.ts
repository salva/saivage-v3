import { z } from 'zod';

export type SeverityLevel = 'info' | 'warning' | 'error';
export type OutboundPolicy = 'internal' | 'operator' | 'audit';
export type EventDomain = 'runtime' | 'agent';

const anyRecord = z.record(z.string(), z.unknown());

const agentRoleSchema = z.enum(['planner', 'executor', 'reviewer', 'manager', 'researcher', 'coder', 'tester', 'ux', 'critic']);
const terminalToolNameSchema = z.enum(['emit_planner_result', 'emit_planner_deferred', 'emit_executor_result', 'emit_reviewer_result']);
const runtimeRecordSchema = anyRecord;
const actionableErrorEnvelopeSchema = anyRecord;
const projectRunCompletedShape = { project_card_id: z.string().optional(), result: z.enum(['done', 'failed', 'blocked']).optional(), summary: z.string().optional(), failure_kind: z.string().optional(), blocked_reason: z.string().optional() } satisfies z.ZodRawShape;

const failureClassSchema = z.enum(['auth_permanent', 'rate_limit', 'server_transient', 'timeout', 'provider_protocol_error', 'capability_mismatch', 'token_budget_exceeded', 'parse_error', 'cancelled', 'unknown']);
const recoveryActionSchema = z.enum(['mark_succeeded', 'cooldown_and_failover', 'failover_without_cooldown', 'retry_same_after_delay', 'abort_without_retry', 'fail_invocation']);
const verdictSchema = z.enum(['succeeded', 'exhausted', 'cancelled']);

const llmAttemptBaseShape = {
  session_id: z.string(),
  role: agentRoleSchema,
  attempt: z.number().int().nonnegative(),
  same_candidate_attempt: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  account: z.string(),
  started_at: z.string().datetime(),
  duration_ms: z.number().nonnegative(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('succeeded'), terminal_tool: terminalToolNameSchema }).strict(),
    z.object({
      kind: z.literal('failed'),
      failure_class: failureClassSchema,
      recovery_action: recoveryActionSchema,
      error_name: z.string(),
      error_message: z.string(),
      error_preview: z.string().optional(),
      cooldown_ms: z.number().nonnegative().optional(),
      retry_delay_ms: z.number().nonnegative().optional(),
    }).strict(),
  ]),
  capability_skip_reasons: z.array(z.object({ provider: z.string(), model: z.string(), reasons: z.array(z.string()) }).strict()).optional(),
} satisfies z.ZodRawShape;

const llmInvocationSummaryBaseShape = {
  session_id: z.string(),
  role: agentRoleSchema,
  goal_id: z.string(),
  card_id: z.string(),
  contract_id: z.string(),
  attempts_count: z.number().int().nonnegative(),
  total_duration_ms: z.number().nonnegative(),
  verdict: verdictSchema,
  repair_attempts: z.number().int().nonnegative(),
  contract_verdict: z.enum(['satisfied', 'repair_exhausted', 'no_progress']).optional(),
  final_provider: z.string().optional(),
  final_model: z.string().optional(),
  final_account: z.string().optional(),
  final_terminal_tool: terminalToolNameSchema.optional(),
  last_failure_class: failureClassSchema.optional(),
} satisfies z.ZodRawShape;

const llmVerifierRejectionBaseShape = {
  session_id: z.string(),
  role: agentRoleSchema,
  contract_id: z.string(),
  attempt: z.number().int().nonnegative(),
  repair_round: z.number().int().positive(),
  obligation_codes: z.array(z.string()),
  proposed_present: z.boolean(),
} satisfies z.ZodRawShape;

export const llmInvocationSummaryRefine = (data: unknown, ctx: z.RefinementCtx): void => {
  const d = data as {
    verdict: 'succeeded' | 'exhausted' | 'cancelled';
    final_provider?: string; final_model?: string; final_account?: string; final_terminal_tool?: string;
    last_failure_class?: string;
  };
  if (d.verdict === 'succeeded') {
    for (const k of ['final_provider', 'final_model', 'final_account', 'final_terminal_tool'] as const) {
      if (!d[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} required when verdict='succeeded'` });
    }
  } else {
    if (!d.last_failure_class) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['last_failure_class'], message: "last_failure_class required when verdict!='succeeded'" });
  }
};

type RegistryEntry = {
  domain: EventDomain;
  strict: boolean;
  baseShape: z.ZodRawShape;
  refine?: (data: unknown, ctx: z.RefinementCtx) => void;
  severity: SeverityLevel;
  tracked: boolean;
  audit: boolean;
  broadcast: boolean;
  outbound: OutboundPolicy;
};

const open = <T extends z.ZodRawShape>(baseShape: T, rest: Omit<RegistryEntry, 'baseShape' | 'strict'>) => ({ ...rest, baseShape, strict: false as const, refine: undefined as ((data: unknown, ctx: z.RefinementCtx) => void) | undefined });

export const EventRegistry = {
  process_reconciled_dead: open({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), probe_status: z.enum(['not_running', 'identity_mismatch', 'clock_skew']), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), detail: z.string() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  process_reattach_rejected: open({ process_id: z.string(), card_id: z.string(), goal_id: z.string().optional(), session_id: z.string().optional(), pid: z.number().nullable().optional(), terminal_reason: z.literal('lost'), failure_classification: z.literal('lost'), reattach_error: z.string(), detail: z.string() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  goal_report_rejected: open({ goal_id: z.string().optional(), reason: z.string().optional(), reviewer_summary: z.string().optional(), missing: z.array(z.string()).optional() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  started: open({}, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  goal_completed: open({ goal_id: z.string() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  goal_failed: open({ goal_id: z.string(), error_message: z.string().optional() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  review_complete: open({ goal_id: z.string(), assessment: z.unknown().optional() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  review_failed: open({ goal_id: z.string(), assessment: z.unknown().optional() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  shutdown: open({}, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  paused: open({}, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  resumed: open({}, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  card_failed: open({ card_id: z.string().optional(), goal_id: z.string().optional() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  escalation: open({ goal_id: z.string(), reason: z.string().optional(), message: z.string().optional() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  plan_updated: open({ goal_id: z.string(), changes: z.array(z.string()).optional() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  dispatch_blocked: open({ reason: z.string(), goal_id: z.string() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  dispatch_interrupted: open({ goal_id: z.string(), reason: z.string() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_diagnostic: open({ goal_id: z.string().optional(), card_id: z.string().optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_actionable_error: open({ actionable_error: actionableErrorEnvelopeSchema }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_fatal_error: open({ phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  startup_session_sweep: open({ swept_session_ids: z.array(z.string()) }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  subscriber_error: open({ subscription_id: z.string(), source_kind: z.string(), error_message: z.string(), error_name: z.string().optional(), timed_out: z.boolean().optional() }, { domain: 'runtime', severity: 'error', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  stuck_supervisor_started: open({ interval_ms: z.number(), consecutive_threshold: z.number() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  stuck_supervisor_stopped: open({ checks_performed: z.number() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  stuck_verdict: open({ verdict: z.boolean(), confidence: z.number(), reason: z.string(), evidence: z.array(z.string()), consecutive_count: z.number(), threshold: z.number() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  abort_target_selected: open({ target_role: z.string(), target_session_id: z.string(), reason: z.string(), consecutive_count: z.number() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  force_cancel_sent: open({ target_role: z.string(), target_session_id: z.string(), reason: z.string() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  project_run_completed: open(projectRunCompletedShape, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_command: open({ command: runtimeRecordSchema }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_run: open({ run: runtimeRecordSchema }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_activation: open({ activation: runtimeRecordSchema }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  frozen: open({ freeze_id: z.string(), reason: z.string() }, { domain: 'runtime', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  resumed_from_freeze: open({ freeze_id: z.string() }, { domain: 'runtime', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  session_started: open({ session_id: z.string(), role: agentRoleSchema, goal_id: z.string(), card_id: z.string() }, { domain: 'agent', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  llm_attempt: { domain: 'agent', strict: true as const, baseShape: llmAttemptBaseShape, refine: undefined as ((data: unknown, ctx: z.RefinementCtx) => void) | undefined, severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  llm_invocation_summary: { domain: 'agent', strict: true as const, baseShape: llmInvocationSummaryBaseShape, refine: llmInvocationSummaryRefine as ((data: unknown, ctx: z.RefinementCtx) => void) | undefined, severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  llm_verifier_rejection: { domain: 'agent', strict: true as const, baseShape: llmVerifierRejectionBaseShape, refine: undefined as ((data: unknown, ctx: z.RefinementCtx) => void) | undefined, severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' },
  compaction_triggered: open({ session_id: z.string(), role: agentRoleSchema, tokens_before: z.number(), tokens_after: z.number() }, { domain: 'agent', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  model_issue: open({ session_id: z.string(), role: agentRoleSchema.optional(), message: z.string() }, { domain: 'agent', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  session_cancelled: open({ session_id: z.string() }, { domain: 'agent', severity: 'warning', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  session_force_cancelled: open({ session_id: z.string() }, { domain: 'agent', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  mcp_tool_invocation: open({ session_id: z.string(), role: agentRoleSchema, server_name: z.string(), tool_name: z.string(), success: z.boolean(), error_message: z.string().optional() }, { domain: 'agent', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  card_history_appended: open({ entry_id: z.string().uuid(), entry_kind: z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']), card_id: z.string(), version_seq: z.number(), changed_fields: z.array(z.string()), changed_at: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  notification_added: open({ session_id: z.string().nullable(), kind: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  control_action_recorded: open({ id: z.string(), action: z.string(), target_kind: z.string().nullable(), target_id: z.string().nullable(), outcome: z.string(), created_at: z.string(), actor: z.string().optional(), surface: z.string().optional() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  analyst_tool_invoked: open({ sessionId: z.string(), tool: z.string(), success: z.boolean(), summary: z.string(), classified_as: z.string().optional(), related_card_id: z.string().optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  control_action_record_appended: open({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  event_log_record_appended: open({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  error_log_record_appended: open({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
} as const satisfies Record<string, RegistryEntry>;

export type EventKind = keyof typeof EventRegistry;
function composePayloadSchema(entry: RegistryEntry): z.ZodTypeAny {
  const obj = z.object(entry.baseShape);
  const shaped = entry.strict ? obj.strict() : obj.passthrough();
  return entry.refine ? shaped.superRefine(entry.refine) : shaped;
}
export const payloadSchemaByKind = Object.fromEntries(
  (Object.keys(EventRegistry) as EventKind[]).map((kind) => [kind, composePayloadSchema(EventRegistry[kind])]),
) as Record<EventKind, z.ZodTypeAny>;
export type EventPayload<K extends EventKind> = (typeof EventRegistry)[K]['strict'] extends true
  ? z.infer<z.ZodObject<(typeof EventRegistry)[K]['baseShape']>>
  : z.infer<z.ZodObject<(typeof EventRegistry)[K]['baseShape']>> & { [key: string]: unknown };
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
  const entry = EventRegistry[kind];
  const { session_id: _s, goal_id: _g, card_id: _c, ...rest } = entry.baseShape as z.ZodRawShape;
  void _s; void _g; void _c;
  const envelopeShape = {
    id: z.string().min(1),
    kind: z.literal(kind),
    timestamp: z.string().datetime(),
    session_id: (entry.baseShape as z.ZodRawShape).session_id ?? z.string().optional(),
    goal_id: (entry.baseShape as z.ZodRawShape).goal_id ?? z.string().optional(),
    card_id: (entry.baseShape as z.ZodRawShape).card_id ?? z.string().optional(),
    ...rest,
  } as z.ZodRawShape;
  const base = z.object(envelopeShape);
  const shaped = entry.strict ? base.strict() : base.passthrough();
  return entry.refine ? shaped.superRefine(entry.refine) : shaped;
}
