import { z } from 'zod';
import { cardIdSchema } from './card-id.js';

export type SeverityLevel = 'info' | 'warning' | 'error';
export type OutboundPolicy = 'internal' | 'operator' | 'audit';
export type EventDomain = 'runtime' | 'agent';

const anyRecord = z.record(z.string(), z.unknown());

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

const strict = <T extends z.ZodRawShape>(baseShape: T, rest: Omit<RegistryEntry, 'baseShape' | 'strict' | 'refine'> & { refine?: (data: unknown, ctx: z.RefinementCtx) => void }) => ({ ...rest, baseShape, strict: true as const });

function refineConversationChanged(data: unknown, ctx: z.RefinementCtx): void {
  const payload = data as Record<string, unknown>;
  if (payload.mutation === 'entry_appended') {
    for (const key of ['message_id', 'message_kind', 'role', 'message_timestamp']) {
      if (payload[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required for entry_appended` });
    }
  }
}

export const EventRegistry = {
  runtime_diagnostic: strict({ goal_id: cardIdSchema.optional(), card_id: cardIdSchema.optional(), phase: z.string().optional(), error_message: z.string(), error_name: z.string().optional(), metadata: anyRecord.optional() }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  runtime_actionable_error: strict({ actionable_error: actionableErrorEnvelopeSchema }, { domain: 'runtime', severity: 'error', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  subscriber_error: strict({ subscription_id: z.string(), source_kind: z.string(), error_message: z.string(), error_name: z.string().optional(), timed_out: z.boolean().optional() }, { domain: 'runtime', severity: 'error', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  mcp_tool_invocation: strict({ server: z.string(), tool: z.string(), success: z.boolean(), duration_ms: z.number().nonnegative(), error: z.string().optional() }, { domain: 'agent', severity: 'info', tracked: true, audit: true, broadcast: true, outbound: 'operator' }),
  card_history_appended: strict({ entry_id: z.string().uuid(), entry_kind: z.enum(['update', 'status', 'mutate', 'depends', 'delete', 'archive']), card_id: cardIdSchema, version_seq: z.number(), changed_fields: z.array(z.string()), changed_at: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  notification_added: strict({ session_id: z.string().nullable(), notification_kind: z.string() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  control_action_recorded: strict({ id: z.string(), action: z.string(), target_kind: z.string().nullable(), target_id: z.string().nullable(), outcome: z.string(), created_at: z.string(), actor: z.string().optional(), surface: z.string().optional() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  analyst_tool_invoked: strict({ sessionId: z.string(), tool: z.string(), success: z.boolean(), summary: z.string(), classified_as: z.string().optional(), related_card_id: cardIdSchema.optional(), related_note_id: z.string().optional(), related_process_id: z.string().optional() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator' }),
  conversation_changed: strict({ session_id: z.string(), mutation: z.literal('entry_appended'), message_id: z.string().optional(), message_kind: z.string().optional(), role: z.string().optional(), message_timestamp: z.string().datetime().optional() }, { domain: 'runtime', severity: 'info', tracked: false, audit: true, broadcast: true, outbound: 'operator', refine: refineConversationChanged }),
  control_action_record_appended: strict({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  event_log_record_appended: strict({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
  error_log_record_appended: strict({ record: anyRecord }, { domain: 'runtime', severity: 'info', tracked: false, audit: false, broadcast: false, outbound: 'internal' }),
} as const satisfies Record<string, RegistryEntry>;

export type EventKind = keyof typeof EventRegistry;
function composePayloadSchema(entry: RegistryEntry): z.ZodTypeAny {
  const obj = z.object(entry.baseShape);
  const shaped = obj.strict();
  return entry.refine ? shaped.superRefine(entry.refine) : shaped;
}
export const payloadSchemaByKind = Object.fromEntries(
  (Object.keys(EventRegistry) as EventKind[]).map((kind) => [kind, composePayloadSchema(EventRegistry[kind])]),
) as Record<EventKind, z.ZodTypeAny>;
export type EventPayload<K extends EventKind> = K extends EventKind
  ? z.infer<z.ZodObject<(typeof EventRegistry)[K]['baseShape']>>
  : never;
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
  const shaped = base.strict();
  return entry.refine ? shaped.superRefine(entry.refine) : shaped;
}
