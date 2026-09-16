import { z } from 'zod';
import { ConversationSessionIdSchema, cardIdSchema, positiveSafeIntegerSchema, recordNameSchema } from '../schemas/index.js';
import {
  AnalystTurnBusyErrorSchema,
  MAX_INBOUND_ANALYST_TEXT_CHARS,
  RestartChatAcknowledgementSchema,
} from './operator-api-chats.js';
import { ToolResultSchema } from './tool-result.js';

const LiveSyncUnscopedResourceSchema = z.literal('runtime');
const LiveSyncCardRecordNameSchema = recordNameSchema;
const LiveSyncCardInvalidateFrameSchema = z.union([
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('cards'),
      scope: z.literal('children'),
      card_id: cardIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('cards'),
      scope: z.literal('detail'),
      card_id: cardIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('cards'),
      scope: z.literal('history'),
      card_id: cardIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('cards'),
      scope: z.literal('diff'),
      card_id: cardIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('cards'),
      scope: z.literal('record'),
      card_id: cardIdSchema,
      record_name: LiveSyncCardRecordNameSchema,
    })
    .strict(),
]);
export const LiveSyncInvalidateFrameSchema = z.union([
  z.object({ t: z.literal('invalidate'), resource: LiveSyncUnscopedResourceSchema }).strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('agent-membership'),
      scope: z.literal('card'),
      card_id: cardIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('agent-membership'),
      scope: z.literal('global-session'),
      session_id: ConversationSessionIdSchema,
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('conversation'),
      id: ConversationSessionIdSchema,
      segment_version: positiveSafeIntegerSchema,
      visible_message_id: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      t: z.literal('invalidate'),
      resource: z.literal('llm-exchange'),
      id: ConversationSessionIdSchema,
    })
    .strict(),
  LiveSyncCardInvalidateFrameSchema,
]);
const agentsLease = <T extends 'subscribe' | 'subscribed' | 'unsubscribe'>(t: T) =>
  z.object({ t: z.literal(t), resource: z.literal('agents'), lease: z.string().min(1) }).strict();
const cardSessionsLease = <T extends 'subscribe' | 'subscribed' | 'unsubscribe'>(t: T) =>
  z
    .object({
      t: z.literal(t),
      resource: z.literal('card-agent-sessions'),
      id: cardIdSchema,
      lease: z.string().min(1),
    })
    .strict();
const sessionLease = <
  T extends 'subscribe' | 'subscribed' | 'unsubscribe',
  R extends 'conversation' | 'llm-exchange',
>(
  t: T,
  resource: R,
) =>
  z
    .object({
      t: z.literal(t),
      resource: z.literal(resource),
      id: ConversationSessionIdSchema,
      lease: z.string().min(1),
    })
    .strict();
export const LiveSyncSubscribedFrameSchema = z.union([
  agentsLease('subscribed'),
  cardSessionsLease('subscribed'),
  sessionLease('subscribed', 'conversation'),
  sessionLease('subscribed', 'llm-exchange'),
]);
export const LiveSyncSubscribeFrameSchema = z.union([
  agentsLease('subscribe'),
  cardSessionsLease('subscribe'),
  sessionLease('subscribe', 'conversation'),
  sessionLease('subscribe', 'llm-exchange'),
]);
export const LiveSyncUnsubscribeFrameSchema = z.union([
  agentsLease('unsubscribe'),
  cardSessionsLease('unsubscribe'),
  sessionLease('unsubscribe', 'conversation'),
  sessionLease('unsubscribe', 'llm-exchange'),
]);
export const LiveSyncClientFrameSchema = z.union([
  LiveSyncSubscribeFrameSchema,
  LiveSyncUnsubscribeFrameSchema,
]);

export type LiveSyncUnscopedResource = z.infer<typeof LiveSyncUnscopedResourceSchema>;
export type LiveSyncCardRecordName = z.infer<typeof LiveSyncCardRecordNameSchema>;
type LiveSyncCardInvalidateFrame = z.infer<typeof LiveSyncCardInvalidateFrameSchema>;
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
export const ConnectedStatusContentSchema = z
  .object({
    event: z.literal('connected'),
    sessionId: ConversationSessionIdSchema,
    timestamp: z.string().datetime(),
    clientCount: z.number().int().nonnegative(),
  })
  .strict();

const ConnectedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: ConnectedStatusContentSchema,
}).strict();

export const AnalystTurnAcknowledgedStatusContentSchema = z
  .object({
    event: z.literal('analyst_turn_acknowledged'),
    sessionId: ConversationSessionIdSchema,
    restart: RestartChatAcknowledgementSchema.nullable(),
  })
  .strict();

const AnalystTurnAcknowledgedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: AnalystTurnAcknowledgedStatusContentSchema,
}).strict();

const AnalystActivityEventNames = [
  'notification_added',
  'control_action_recorded',
  'analyst_tool_invoked',
  'tool_invocation',
] as const;

export const NotificationAddedContentSchema = z
  .object({
    event: z.literal('notification_added'),
    session_id: z.string().nullable(),
    kind: z.string().min(1),
  })
  .strict();

export const ControlActionRecordedContentSchema = z
  .object({
    event: z.literal('control_action_recorded'),
    id: z.string().min(1),
    action: z.string().min(1),
    target_kind: stringOrNullSchema,
    target_id: stringOrNullSchema,
    outcome: z.string().min(1),
    created_at: z.string().min(1),
    actor: optionalStringSchema,
    surface: optionalStringSchema,
  })
  .strict();

export const AnalystToolInvokedContentSchema = z
  .object({
    event: z.literal('analyst_tool_invoked'),
    sessionId: ConversationSessionIdSchema,
    tool: z.string().min(1),
    success: z.boolean(),
    summary: z.string(),
    classified_as: optionalStringSchema,
    related_card_id: optionalStringSchema,
    related_note_id: optionalStringSchema,
    related_process_id: optionalStringSchema,
  })
  .strict();

export const ClassifiedToolInvocationActivityContentSchema = z
  .object({
    event: z.literal('tool_invocation'),
    sessionId: ConversationSessionIdSchema,
    tool: z.string().min(1),
    params: z.unknown(),
    result: ToolResultSchema,
  })
  .strict();

const AnalystActivityContentSchema = z.discriminatedUnion('event', [
  NotificationAddedContentSchema,
  ControlActionRecordedContentSchema,
  AnalystToolInvokedContentSchema,
  ClassifiedToolInvocationActivityContentSchema,
]);

const ServerActivityEnvelopeSchema = z.object({
  type: z.literal('activity'),
  content: AnalystActivityContentSchema,
}).strict();

export const MAX_ANALYST_WS_FRAME_BYTES = 1_048_576;

export const InboundAnalystMessageContentSchema = z
  .object({
    text: z.string().min(1).max(MAX_INBOUND_ANALYST_TEXT_CHARS),
  })
  .strict();

export const InboundAnalystMessageEnvelopeSchema = z.object({
  type: z.literal('message'),
  content: InboundAnalystMessageContentSchema,
}).strict();

const AnalystProcessingFailedErrorSchema = z.object({
    error: z.literal('analyst_processing_failed'),
    message: z.literal('Failed to process Analyst message.'),
  })
  .strict();
export const ANALYST_PROCESSING_FAILED_ERROR = Object.freeze(
  AnalystProcessingFailedErrorSchema.parse({
    error: 'analyst_processing_failed',
    message: 'Failed to process Analyst message.',
  }),
);
const AnalystWsErrorContentSchema = z.discriminatedUnion('error', [
  AnalystTurnBusyErrorSchema,
  AnalystProcessingFailedErrorSchema,
]);
export const ErrorEnvelopeSchema = z
  .object({
    type: z.literal('error'),
    content: AnalystWsErrorContentSchema,
  })
  .strict();

const ServerStatusWsEnvelopeSchema = z.union([
  ConnectedStatusEnvelopeSchema,
  AnalystTurnAcknowledgedStatusEnvelopeSchema,
]);

export const ServerEgressWsEnvelopeSchema = z.union([
  ServerStatusWsEnvelopeSchema,
  ServerActivityEnvelopeSchema,
  ErrorEnvelopeSchema,
]);

const analystActivityEventNameSet = new Set<string>(AnalystActivityEventNames);

export type ServerEgressWsEnvelope = z.infer<typeof ServerEgressWsEnvelopeSchema>;
export type ClassifiedToolInvocationActivityContent = z.infer<
  typeof ClassifiedToolInvocationActivityContentSchema
>;
export type InboundAnalystMessageEnvelope = z.infer<typeof InboundAnalystMessageEnvelopeSchema>;
type AnalystActivityContent = z.infer<typeof AnalystActivityContentSchema>;

function getContentEvent(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const event = (content as Record<string, unknown>).event;
  return typeof event === 'string' ? event : null;
}

export function parseServerEgressWsEnvelope(envelope: unknown): ServerEgressWsEnvelope {
  return ServerEgressWsEnvelopeSchema.parse(envelope);
}

export function isAnalystActivityContent(content: unknown): content is AnalystActivityContent {
  const event = getContentEvent(content);
  return Boolean(
    event &&
    analystActivityEventNameSet.has(event) &&
    AnalystActivityContentSchema.safeParse(content).success,
  );
}

export function parseAnalystTurnAcknowledgedStatusContent(
  input: unknown,
): z.infer<typeof AnalystTurnAcknowledgedStatusContentSchema> | null {
  const parsed = AnalystTurnAcknowledgedStatusContentSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function buildConnectedEnvelope(input: {
  sessionId: z.infer<typeof ConversationSessionIdSchema>;
  timestamp?: string;
  clientCount?: number;
}): z.infer<typeof ConnectedStatusEnvelopeSchema> {
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
