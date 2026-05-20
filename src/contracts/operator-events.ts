import { z } from 'zod';
import { eventKindValues } from '../schemas/types.js';
import { cardStatusSchema, cardTypeSchema, eventKindSchema, loggedEventSchemaByKind } from '../schemas/validators.js';
import { CardIndexSummarySchema, RuntimeGetStateResponseSchema } from './operator-api.js';

export const WsEventTypeSchema = z.enum(['message', 'activity', 'thinking', 'status', 'error']);
export const WsEnvelopeSchema = z.object({
  type: WsEventTypeSchema,
  content: z.record(z.string(), z.unknown()),
});

const stringOrNullSchema = z.string().nullable();
const optionalStringSchema = z.string().optional();
const optionalIsoStringSchema = z.string().optional();
const passthroughRecordSchema = z.record(z.string(), z.unknown());

export const ConnectedStatusContentSchema = z.object({
  event: z.literal('connected'),
  sessionId: z.string().min(1),
  timestamp: z.string().datetime(),
  clientCount: z.number().int().nonnegative(),
}).passthrough();

export const ConnectedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: ConnectedStatusContentSchema,
});

export const RuntimeStateStatusEventSchema = z.object({
  type: z.literal('status'),
  content: z.object({
    event: z.literal('runtime-state'),
    runtime: RuntimeGetStateResponseSchema.shape.runtime.optional(),
    cardIndex: CardIndexSummarySchema.optional(),
  }).passthrough(),
});

export const RuntimePausedStatusEventSchema = z.object({
  type: z.literal('status'),
  content: z.object({
    event: z.literal('runtime-paused'),
  }).passthrough(),
});

export const RuntimeResumedStatusEventSchema = z.object({
  type: z.literal('status'),
  content: z.object({
    event: z.literal('runtime-resumed'),
  }).passthrough(),
});

export const CardStatusChangedEventSchema = z.object({
  type: z.literal('status'),
  content: z.object({
    event: z.literal('card-status-changed'),
    card: z.object({ id: z.string().min(1), status: cardStatusSchema.optional(), type: cardTypeSchema.optional(), title: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
});

export const AnalystActivityEventNames = [
  'card_history_appended',
  'notification_added',
  'notification_acknowledged',
  'control_action_recorded',
  'analyst_tool_invoked',
  'tool_invocation',
] as const;

export const CardHistoryAppendedContentSchema = z.object({
  event: z.literal('card_history_appended'),
  card_id: z.string().min(1),
  version_seq: z.number().int(),
  changed_fields: z.array(z.string()),
  changed_at: z.string().min(1),
}).passthrough();

export const NotificationAddedContentSchema = z.object({
  event: z.literal('notification_added'),
  id: z.string().min(1),
  kind: z.string().min(1),
  severity: z.string().min(1),
  related_card_id: optionalStringSchema,
  related_note_id: optionalStringSchema,
  related_process_id: optionalStringSchema,
  related_version_seq: z.number().optional(),
  created_at: z.string().min(1),
}).passthrough();

export const NotificationAcknowledgedContentSchema = z.object({
  event: z.literal('notification_acknowledged'),
  id: z.string().min(1),
  kind: z.string().min(1),
  related_card_id: optionalStringSchema,
  related_note_id: optionalStringSchema,
  related_process_id: optionalStringSchema,
  acknowledged_at: z.string().min(1),
}).passthrough();

export const ControlActionRecordedContentSchema = z.object({
  event: z.literal('control_action_recorded'),
  id: z.string().min(1),
  action: z.string().min(1),
  target_kind: stringOrNullSchema,
  target_id: stringOrNullSchema,
  outcome: z.string().min(1),
  created_at: z.string().min(1),
  actor: optionalStringSchema,
  surface: optionalStringSchema,
}).passthrough();

export const AnalystToolInvokedContentSchema = z.object({
  event: z.literal('analyst_tool_invoked'),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  success: z.boolean(),
  summary: z.string(),
  classified_as: optionalStringSchema,
  related_card_id: optionalStringSchema,
  related_note_id: optionalStringSchema,
  related_process_id: optionalStringSchema,
}).passthrough();

export const ToolInvocationContentSchema = z.object({
  event: z.literal('tool_invocation'),
  tool: z.string().min(1),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
}).passthrough();

export const AnalystActivityContentSchema = z.discriminatedUnion('event', [
  CardHistoryAppendedContentSchema,
  NotificationAddedContentSchema,
  NotificationAcknowledgedContentSchema,
  ControlActionRecordedContentSchema,
  AnalystToolInvokedContentSchema,
  ToolInvocationContentSchema,
]);

export const AnalystActivityEnvelopeSchema = z.object({
  type: z.literal('activity'),
  content: AnalystActivityContentSchema,
});

export const InboundAnalystMessageContentSchema = z.object({
  text: z.string().min(1),
}).passthrough();

export const InboundAnalystMessageEnvelopeSchema = z.object({
  type: z.literal('message'),
  content: InboundAnalystMessageContentSchema,
});

export const AnalystMessageEnvelopeSchema = z.object({
  type: z.literal('message'),
  content: passthroughRecordSchema,
});

export const ErrorEnvelopeSchema = z.object({
  type: z.literal('error'),
  content: passthroughRecordSchema,
});

export const RuntimeFanoutContentSchema = z.object({
  event: eventKindSchema,
}).passthrough();

export const RuntimeFanoutWsEnvelopeSchema = z.union([
  z.object({ type: z.literal('status'), content: RuntimeFanoutContentSchema }),
  z.object({ type: z.literal('activity'), content: RuntimeFanoutContentSchema }),
  z.object({ type: z.literal('error'), content: RuntimeFanoutContentSchema }),
]);

export const CoveredRuntimeStatusEventSchema = z.discriminatedUnion('event', [
  RuntimeStateStatusEventSchema.shape.content,
  RuntimePausedStatusEventSchema.shape.content,
  RuntimeResumedStatusEventSchema.shape.content,
  CardStatusChangedEventSchema.shape.content,
]);

export const CoveredWsEnvelopeSchema = z.union([
  RuntimeStateStatusEventSchema,
  RuntimePausedStatusEventSchema,
  RuntimeResumedStatusEventSchema,
  CardStatusChangedEventSchema,
]);

export const KnownStatusWsEnvelopeSchema = z.union([
  ConnectedStatusEnvelopeSchema,
  RuntimeStateStatusEventSchema,
  RuntimePausedStatusEventSchema,
  RuntimeResumedStatusEventSchema,
  CardStatusChangedEventSchema,
]);

export const KnownWsContentSchema = z.union([
  ConnectedStatusContentSchema,
  CoveredRuntimeStatusEventSchema,
  AnalystActivityContentSchema,
  RuntimeFanoutContentSchema,
]);

export const KnownWsEnvelopeSchema = z.union([
  KnownStatusWsEnvelopeSchema,
  AnalystActivityEnvelopeSchema,
  RuntimeFanoutWsEnvelopeSchema,
  InboundAnalystMessageEnvelopeSchema,
  AnalystMessageEnvelopeSchema,
  ErrorEnvelopeSchema,
]);

export const knownRuntimeFanoutEventNames = [...eventKindValues] as const;
export const knownWsContentEventNames = [
  'connected',
  'runtime-state',
  'runtime-paused',
  'runtime-resumed',
  'card-status-changed',
  ...AnalystActivityEventNames,
  ...knownRuntimeFanoutEventNames,
] as const;

const knownWsContentEventNameSet = new Set<string>(knownWsContentEventNames);
const analystActivityEventNameSet = new Set<string>(AnalystActivityEventNames);
const runtimeFanoutEventNameSet = new Set<string>(knownRuntimeFanoutEventNames);

export type WsEventType = z.infer<typeof WsEventTypeSchema>;
export type WsEnvelopeContract = z.infer<typeof WsEnvelopeSchema>;
export type WsEnvelope = WsEnvelopeContract;
export type CoveredWsEnvelope = z.infer<typeof CoveredWsEnvelopeSchema>;
export type CoveredRuntimeStatusEvent = z.infer<typeof CoveredRuntimeStatusEventSchema>;
export type KnownWsEnvelope = z.infer<typeof KnownWsEnvelopeSchema>;
export type KnownWsContent = z.infer<typeof KnownWsContentSchema>;
export type KnownStatusWsEnvelope = z.infer<typeof KnownStatusWsEnvelopeSchema>;
export type KnownActivityWsEnvelope = z.infer<typeof AnalystActivityEnvelopeSchema>;
export type InboundAnalystMessageEnvelope = z.infer<typeof InboundAnalystMessageEnvelopeSchema>;
export type RuntimeFanoutWsEnvelope = z.infer<typeof RuntimeFanoutWsEnvelopeSchema>;
export type AnalystActivityContent = z.infer<typeof AnalystActivityContentSchema>;

function getContentEvent(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const event = (content as Record<string, unknown>).event;
  return typeof event === 'string' ? event : null;
}

function validateRuntimeFanoutContent(content: unknown): RuntimeFanoutWsEnvelope['content'] {
  const base = RuntimeFanoutContentSchema.parse(content);
  const event = base.event;
  const eventPayload = { ...base, kind: event, id: '__ws_projection__', timestamp: new Date(0).toISOString() };
  delete (eventPayload as Record<string, unknown>).event;
  loggedEventSchemaByKind[event as keyof typeof loggedEventSchemaByKind].parse(eventPayload);
  return base;
}

export function parseWsEnvelope(input: unknown): WsEnvelopeContract | null {
  const parsed = WsEnvelopeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseKnownWsContent(content: unknown): KnownWsContent | null {
  const event = getContentEvent(content);
  if (!event || !knownWsContentEventNameSet.has(event)) return null;
  if (runtimeFanoutEventNameSet.has(event)) return validateRuntimeFanoutContent(content);
  return KnownWsContentSchema.parse(content);
}

export function parseKnownWsEnvelope(envelope: unknown): KnownWsEnvelope | null {
  const base = WsEnvelopeSchema.safeParse(envelope);
  if (!base.success) return null;
  const event = getContentEvent(base.data.content);
  if (event) {
    if (!knownWsContentEventNameSet.has(event)) return null;
    parseKnownWsContent(base.data.content);
    return KnownWsEnvelopeSchema.parse(base.data);
  }
  if (base.data.type === 'message' || base.data.type === 'error') {
    return KnownWsEnvelopeSchema.parse(base.data);
  }
  return null;
}

export function parseCoveredWsEnvelope(envelope: unknown): CoveredWsEnvelope | null {
  const base = WsEnvelopeSchema.safeParse(envelope);
  if (!base.success) return null;
  const event = base.data.content.event;
  if (event !== 'runtime-state' && event !== 'runtime-paused' && event !== 'runtime-resumed' && event !== 'card-status-changed') {
    return null;
  }
  return CoveredWsEnvelopeSchema.parse(envelope);
}

export function parseCoveredRuntimeStatusContent(content: unknown): CoveredRuntimeStatusEvent | null {
  const event = getContentEvent(content);
  if (event !== 'runtime-state' && event !== 'runtime-paused' && event !== 'runtime-resumed' && event !== 'card-status-changed') {
    return null;
  }
  return CoveredRuntimeStatusEventSchema.parse(content);
}

export function validateKnownWsEnvelope(envelope: WsEnvelopeContract): WsEnvelopeContract {
  parseKnownWsEnvelope(envelope);
  return envelope;
}

export function isAnalystActivityContent(content: unknown): content is AnalystActivityContent {
  const event = getContentEvent(content);
  return Boolean(event && analystActivityEventNameSet.has(event) && AnalystActivityContentSchema.safeParse(content).success);
}

export function isRuntimeFanoutContent(content: unknown): content is RuntimeFanoutWsEnvelope['content'] {
  const event = getContentEvent(content);
  return Boolean(event && runtimeFanoutEventNameSet.has(event) && RuntimeFanoutContentSchema.safeParse(content).success);
}

export function isConnectedEnvelope(envelope: unknown): envelope is z.infer<typeof ConnectedStatusEnvelopeSchema> {
  return ConnectedStatusEnvelopeSchema.safeParse(envelope).success;
}

export function buildConnectedEnvelope(input: { sessionId: string; timestamp?: string; clientCount?: number }): z.infer<typeof ConnectedStatusEnvelopeSchema> {
  return ConnectedStatusEnvelopeSchema.parse({
    type: 'status',
    content: {
      event: 'connected',
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? new Date(0).toISOString(),
      clientCount: input.clientCount ?? 1,
    },
  });
}

export function buildInboundAnalystMessageEnvelope(text: string): InboundAnalystMessageEnvelope {
  return InboundAnalystMessageEnvelopeSchema.parse({ type: 'message', content: { text } });
}

export function buildRuntimeFanoutEnvelope(input: { type?: 'status' | 'activity' | 'error'; event: typeof eventKindValues[number]; content?: Record<string, unknown> }): RuntimeFanoutWsEnvelope {
  const envelope = { type: input.type ?? 'status', content: { event: input.event, ...(input.content ?? {}) } };
  parseKnownWsEnvelope(envelope);
  return envelope as RuntimeFanoutWsEnvelope;
}

export const wsContractFixtures = {
  connected: buildConnectedEnvelope({ sessionId: 'session-fixture' }),
  inboundAnalystMessage: buildInboundAnalystMessageEnvelope('hello analyst'),
  unknownBaseValid: { type: 'activity', content: { event: 'future_event', value: true } } satisfies WsEnvelopeContract,
  malformedKnown: { type: 'activity', content: { event: 'card_history_appended' } } satisfies WsEnvelopeContract,
};
