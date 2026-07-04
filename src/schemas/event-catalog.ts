import { z } from 'zod';

export type SeverityLevel = 'info' | 'warning' | 'error';
export type OutboundPolicy = 'internal' | 'operator' | 'audit';
export type EventDomain = 'runtime' | 'agent';

const anyRecord = z.record(z.string(), z.unknown());

const agentRoleSchema = z.enum(['planner', 'executor', 'reviewer', 'manager', 'researcher', 'coder', 'tester', 'ux', 'critic']);
const actionableErrorEnvelopeSchema = anyRecord;

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
  runtime_diagnostic: open({ goal_id: z.string().optional(), card_id: z.string().optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_actionable_error: open({ actionable_error: actionableErrorEnvelopeSchema }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  subscriber_error: open({ subscription_id: z.string(), source_kind: z.string(), error_message: z.string(), error_name: z.string().optional(), timed_out: z.boolean().optional() }, { domain: 'runtime', severity: 'error', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  mcp_tool_invocation: open({ session_id: z.string(), role: agentRoleSchema, server_name: z.string(), tool_name: z.string(), success: z.boolean(), error_message: z.string().optional() }, { domain: 'agent', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  card_history_appended: open({ entry_id: z.string().uuid(), entry_kind: z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']), card_id: z.string(), version_seq: z.number(), changed_fields: z.array(z.string()), changed_at: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  notification_added: open({ session_id: z.string().nullable(), notification_kind: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
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
  const { kind: _k, session_id: _s, goal_id: _g, card_id: _c, ...rest } = entry.baseShape as z.ZodRawShape;
  void _k; void _s; void _g; void _c;
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
