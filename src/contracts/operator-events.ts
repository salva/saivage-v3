import { z } from 'zod';
import { ConversationSessionIdSchema, cardIdSchema, recordNameSchema } from '../schemas/index.js';
import { RestartChatAcknowledgementSchema } from './operator-api-chats.js';
import { ToolInvocationResultSchema } from './tool-invocation-projection.js';

export const WsEventTypeSchema = z.enum(['message', 'activity', 'thinking', 'status', 'error']);
export const WsEnvelopeSchema = z.object({
  type: WsEventTypeSchema,
  content: z.record(z.string(), z.unknown()),
});

export const LiveSyncUnscopedResourceSchema = z.enum(['runtime', 'agents', 'timeline', 'processes', 'files']);
export const LiveSyncCardRecordNameSchema = recordNameSchema;
export const LiveSyncCardInvalidateFrameSchema = z.union([
  z.object({ t: z.literal('invalidate'), resource: z.literal('cards'), scope: z.literal('children'), card_id: cardIdSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('cards'), scope: z.literal('detail'), card_id: cardIdSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('cards'), scope: z.literal('history'), card_id: cardIdSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('cards'), scope: z.literal('diff'), card_id: cardIdSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('cards'), scope: z.literal('record'), card_id: cardIdSchema, record_name: LiveSyncCardRecordNameSchema }).strict(),
]);
export const LiveSyncInvalidateFrameSchema = z.union([
  z.object({ t: z.literal('invalidate'), resource: LiveSyncUnscopedResourceSchema }).strict(),
  z.object({ t: z.literal('invalidate'), resource: z.literal('conversation'), id: ConversationSessionIdSchema }).strict(),
  LiveSyncCardInvalidateFrameSchema,
]);
export const LiveSyncSubscribedFrameSchema = z.object({ t: z.literal('subscribed'), resource: z.literal('conversation'), id: ConversationSessionIdSchema, lease: z.string().min(1) }).strict();
export const LiveSyncSubscribeFrameSchema = z.object({ t: z.literal('subscribe'), resource: z.literal('conversation'), id: ConversationSessionIdSchema, lease: z.string().min(1) }).strict();
export const LiveSyncUnsubscribeFrameSchema = z.object({ t: z.literal('unsubscribe'), resource: z.literal('conversation'), id: ConversationSessionIdSchema, lease: z.string().min(1) }).strict();
export const LiveSyncClientFrameSchema = z.union([LiveSyncSubscribeFrameSchema, LiveSyncUnsubscribeFrameSchema]);

export type LiveSyncUnscopedResource = z.infer<typeof LiveSyncUnscopedResourceSchema>;
export type LiveSyncCardRecordName = z.infer<typeof LiveSyncCardRecordNameSchema>;
export type LiveSyncCardInvalidateFrame = z.infer<typeof LiveSyncCardInvalidateFrameSchema>;
export type LiveSyncInvalidateFrame = z.infer<typeof LiveSyncInvalidateFrameSchema>;
export type LiveSyncSubscribedFrame = z.infer<typeof LiveSyncSubscribedFrameSchema>;
export type LiveSyncClientFrame = z.infer<typeof LiveSyncClientFrameSchema>;
export type LiveSyncInvalidateTarget = LiveSyncInvalidateFrame extends infer T
  ? T extends { t: 'invalidate' }
    ? Omit<T, 't'>
    : never
  : never;
export type LiveSyncCardInvalidateTarget = LiveSyncCardInvalidateFrame extends infer T
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
export const ConnectedStatusContentSchema = z.object({
  event: z.literal('connected'),
  sessionId: ConversationSessionIdSchema,
  timestamp: z.string().datetime(),
  clientCount: z.number().int().nonnegative(),
}).passthrough();

export const ConnectedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: ConnectedStatusContentSchema,
});

export const AnalystTurnAcknowledgedStatusContentSchema = z.object({
  event: z.literal('analyst_turn_acknowledged'),
  sessionId: ConversationSessionIdSchema,
  restart: RestartChatAcknowledgementSchema.nullable(),
}).strict();

export const AnalystTurnAcknowledgedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: AnalystTurnAcknowledgedStatusContentSchema,
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
  card_id: cardIdSchema,
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
  sessionId: ConversationSessionIdSchema,
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
  sessionId: ConversationSessionIdSchema,
  tool: z.string().min(1),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
}).passthrough();

export const ClassifiedToolInvocationActivityContentSchema = z.object({
  event: z.literal('tool_invocation'),
  sessionId: ConversationSessionIdSchema,
  tool: z.string().min(1),
  params: z.unknown(),
  result: ToolInvocationResultSchema,
}).strict();

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

export const ErrorEnvelopeSchema = z.object({
  type: z.literal('error'),
  content: z.record(z.string(), z.unknown()),
});

export const KnownStatusWsEnvelopeSchema = z.union([ConnectedStatusEnvelopeSchema, AnalystTurnAcknowledgedStatusEnvelopeSchema]);

export const KnownWsContentSchema = z.union([
  ConnectedStatusContentSchema,
  AnalystTurnAcknowledgedStatusContentSchema,
  AnalystActivityContentSchema,
]);

export const KnownWsEnvelopeSchema = z.union([
  KnownStatusWsEnvelopeSchema,
  AnalystActivityEnvelopeSchema,
  InboundAnalystMessageEnvelopeSchema,
  ErrorEnvelopeSchema,
]);

const ClassifiedAnalystActivityContentSchema = z.discriminatedUnion('event', [
  CardHistoryAppendedContentSchema,
  NotificationAddedContentSchema,
  ControlActionRecordedContentSchema,
  AnalystToolInvokedContentSchema,
  ClassifiedToolInvocationActivityContentSchema,
]);
export const KnownWsEnvelopeWithClassifiedToolActivitySchema = z.union([
  KnownStatusWsEnvelopeSchema,
  z.object({ type: z.literal('activity'), content: ClassifiedAnalystActivityContentSchema }),
  InboundAnalystMessageEnvelopeSchema,
  ErrorEnvelopeSchema,
]);

export const knownWsContentEventNames = [
  'connected',
  'analyst_turn_acknowledged',
  ...AnalystActivityEventNames,
] as const;

const knownWsContentEventNameSet = new Set<string>(knownWsContentEventNames);
const analystActivityEventNameSet = new Set<string>(AnalystActivityEventNames);

export type WsEventType = z.infer<typeof WsEventTypeSchema>;
export type WsEnvelopeContract = z.infer<typeof WsEnvelopeSchema>;
export type WsEnvelope = WsEnvelopeContract;
export type KnownWsEnvelope = z.infer<typeof KnownWsEnvelopeSchema>;
export type KnownWsEnvelopeWithClassifiedToolActivity = z.infer<typeof KnownWsEnvelopeWithClassifiedToolActivitySchema>;
export type ClassifiedToolInvocationActivityContent = z.infer<typeof ClassifiedToolInvocationActivityContentSchema>;
export type KnownWsContent = z.infer<typeof KnownWsContentSchema>;
export type KnownStatusWsEnvelope = z.infer<typeof KnownStatusWsEnvelopeSchema>;
export type AnalystTurnAcknowledgedStatusEnvelope = z.infer<typeof AnalystTurnAcknowledgedStatusEnvelopeSchema>;
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

export function parseAnalystTurnAcknowledgedStatusContent(input: unknown): z.infer<typeof AnalystTurnAcknowledgedStatusContentSchema> | null {
  const parsed = AnalystTurnAcknowledgedStatusContentSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function isConnectedEnvelope(envelope: unknown): envelope is z.infer<typeof ConnectedStatusEnvelopeSchema> {
  return ConnectedStatusEnvelopeSchema.safeParse(envelope).success;
}

export function buildConnectedEnvelope(input: { sessionId:z.infer<typeof ConversationSessionIdSchema>;timestamp?: string; clientCount?: number }): z.infer<typeof ConnectedStatusEnvelopeSchema> {
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
  connected: buildConnectedEnvelope({sessionId:'agent:fixture:global'}),
  inboundAnalystMessage: buildInboundAnalystMessageEnvelope('hello analyst'),
  unknownBaseValid: { type: 'activity', content: { event: 'future_event', value: true } } satisfies WsEnvelopeContract,
  malformedKnown: { type: 'activity', content: { event: 'card_history_appended' } } satisfies WsEnvelopeContract,
};
