import { z } from 'zod';
import { ConversationSessionIdSchema, cardIdSchema, positiveSafeIntegerSchema, recordNameSchema } from '../schemas/index.js';

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

export const ConnectedStatusContentSchema = z
  .object({
    event: z.literal('connected'),
    timestamp: z.string().datetime(),
    clientCount: z.number().int().nonnegative(),
  })
  .strict();

const ConnectedStatusEnvelopeSchema = z.object({
  type: z.literal('status'),
  content: ConnectedStatusContentSchema,
}).strict();

export const MAX_WS_FRAME_BYTES = 1_048_576;
export const ServerEgressWsEnvelopeSchema = ConnectedStatusEnvelopeSchema;

export type ServerEgressWsEnvelope = z.infer<typeof ServerEgressWsEnvelopeSchema>;

export function parseServerEgressWsEnvelope(envelope: unknown): ServerEgressWsEnvelope {
  return ServerEgressWsEnvelopeSchema.parse(envelope);
}

export function buildConnectedEnvelope(input: {
  timestamp?: string;
  clientCount?: number;
}): z.infer<typeof ConnectedStatusEnvelopeSchema> {
  return ConnectedStatusEnvelopeSchema.parse({
    type: 'status',
    content: {
      event: 'connected',
      timestamp: input.timestamp ?? new Date(0).toISOString(),
      clientCount: input.clientCount ?? 1,
    },
  });
}
