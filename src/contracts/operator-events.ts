import { z } from 'zod';

export const WsEventTypeSchema = z.enum(['message', 'activity', 'thinking', 'status', 'error']);
export const WsEnvelopeSchema = z.object({
  type: WsEventTypeSchema,
  content: z.record(z.string(), z.unknown()),
});

export const LiveSyncUnscopedResourceSchema = z.enum(['runtime', 'cards', 'agents', 'timeline', 'processes', 'files']);
export const LiveSyncInvalidateFrameSchema = z.union([
  z.object({ t: z.literal('invalidate'), resource: LiveSyncUnscopedResourceSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('conversation'), id: z.string().min(1) }).strict(),
]);
export const LiveSyncSubscribeFrameSchema = z.object({ t: z.literal('subscribe'), resource: z.literal('conversation'), id: z.string().min(1) }).strict();
export const LiveSyncUnsubscribeFrameSchema = z.object({ t: z.literal('unsubscribe'), resource: z.literal('conversation'), id: z.string().min(1) }).strict();
export const LiveSyncClientFrameSchema = z.union([LiveSyncSubscribeFrameSchema, LiveSyncUnsubscribeFrameSchema]);

export type LiveSyncUnscopedResource = z.infer<typeof LiveSyncUnscopedResourceSchema>;
export type LiveSyncInvalidateFrame = z.infer<typeof LiveSyncInvalidateFrameSchema>;
export type LiveSyncClientFrame = z.infer<typeof LiveSyncClientFrameSchema>;
export type LiveSyncInvalidateTarget = LiveSyncInvalidateFrame extends infer T
  ? T extends { t: 'invalidate' }
    ? Omit<T, 't'>
    : never
  : never;

export function parseLiveSyncClientFrame(input: unknown): LiveSyncClientFrame | null {
  const parsed = LiveSyncClientFrameSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

const stringOrNullSchema = z.string().nullable();
const optionalStringSchema = z.string().optional();
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

export const AnalystActivityEventNames = [
  'card_history_appended',
  'notification_added',
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
  session_id: z.string().nullable(),
  kind: z.string().min(1),
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

export const KnownStatusWsEnvelopeSchema = ConnectedStatusEnvelopeSchema;

export const KnownWsContentSchema = z.union([
  ConnectedStatusContentSchema,
  AnalystActivityContentSchema,
]);

export const KnownWsEnvelopeSchema = z.union([
  KnownStatusWsEnvelopeSchema,
  AnalystActivityEnvelopeSchema,
  InboundAnalystMessageEnvelopeSchema,
  AnalystMessageEnvelopeSchema,
  ErrorEnvelopeSchema,
]);

export const knownWsContentEventNames = [
  'connected',
  ...AnalystActivityEventNames,
] as const;

const knownWsContentEventNameSet = new Set<string>(knownWsContentEventNames);
const analystActivityEventNameSet = new Set<string>(AnalystActivityEventNames);

export type WsEventType = z.infer<typeof WsEventTypeSchema>;
export type WsEnvelopeContract = z.infer<typeof WsEnvelopeSchema>;
export type WsEnvelope = WsEnvelopeContract;
export type KnownWsEnvelope = z.infer<typeof KnownWsEnvelopeSchema>;
export type KnownWsContent = z.infer<typeof KnownWsContentSchema>;
export type KnownStatusWsEnvelope = z.infer<typeof KnownStatusWsEnvelopeSchema>;
export type KnownActivityWsEnvelope = z.infer<typeof AnalystActivityEnvelopeSchema>;
export type InboundAnalystMessageEnvelope = z.infer<typeof InboundAnalystMessageEnvelopeSchema>;
export type AnalystActivityContent = z.infer<typeof AnalystActivityContentSchema>;

function getContentEvent(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const event = (content as Record<string, unknown>).event;
  return typeof event === 'string' ? event : null;
}

export function parseWsEnvelope(input: unknown): WsEnvelopeContract | null {
  const parsed = WsEnvelopeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseKnownWsContent(content: unknown): KnownWsContent | null {
  const event = getContentEvent(content);
  if (!event || !knownWsContentEventNameSet.has(event)) return null;
  const known = KnownWsContentSchema.safeParse(content);
  if (known.success) return known.data;
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

export function validateKnownWsEnvelope(envelope: WsEnvelopeContract): WsEnvelopeContract {
  parseKnownWsEnvelope(envelope);
  return envelope;
}

export function isAnalystActivityContent(content: unknown): content is AnalystActivityContent {
  const event = getContentEvent(content);
  return Boolean(event && analystActivityEventNameSet.has(event) && AnalystActivityContentSchema.safeParse(content).success);
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

export const wsContractFixtures = {
  connected: buildConnectedEnvelope({ sessionId: 'session-fixture' }),
  inboundAnalystMessage: buildInboundAnalystMessageEnvelope('hello analyst'),
  unknownBaseValid: { type: 'activity', content: { event: 'future_event', value: true } } satisfies WsEnvelopeContract,
  malformedKnown: { type: 'activity', content: { event: 'card_history_appended' } } satisfies WsEnvelopeContract,
};
