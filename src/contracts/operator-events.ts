import { z } from 'zod';
import { cardStatusSchema, cardTypeSchema } from '../schemas/validators.js';
import { CardIndexSummarySchema, RuntimeGetStateResponseSchema } from './operator-api.js';

export const WsEventTypeSchema = z.enum(['message', 'activity', 'thinking', 'status', 'error']);
export const WsEnvelopeSchema = z.object({
  type: WsEventTypeSchema,
  content: z.record(z.string(), z.unknown()),
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

export type WsEnvelopeContract = z.infer<typeof WsEnvelopeSchema>;
export type CoveredWsEnvelope = z.infer<typeof CoveredWsEnvelopeSchema>;
export type CoveredRuntimeStatusEvent = z.infer<typeof CoveredRuntimeStatusEventSchema>;

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
  const event = typeof content === 'object' && content !== null ? (content as Record<string, unknown>).event : undefined;
  if (event !== 'runtime-state' && event !== 'runtime-paused' && event !== 'runtime-resumed' && event !== 'card-status-changed') {
    return null;
  }
  return CoveredRuntimeStatusEventSchema.parse(content);
}

export function validateKnownWsEnvelope(envelope: WsEnvelopeContract): WsEnvelopeContract {
  const parsed = parseCoveredWsEnvelope(envelope);
  return parsed ?? envelope;
}
