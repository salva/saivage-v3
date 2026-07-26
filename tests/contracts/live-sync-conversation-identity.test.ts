import { describe, expect, it } from '@jest/globals';

import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  LiveSyncSubscribeFrameSchema,
  LiveSyncUnsubscribeFrameSchema,
  buildConnectedEnvelope,
  parseKnownWsContent,
  parseKnownWsEnvelope,
  parseLiveSyncClientFrame,
} from '../../src/contracts/operator-events.js';

const valid = ['agent:analyst:global', 'agent:planner:project', 'agent:reviewer:project', 'agent:executor:project'] as const;
const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;

describe('live-sync conversation identity contracts', () => {
  it.each(valid)('accepts every frame kind for exact identity %s', (id) => {
    expect(parseLiveSyncClientFrame({ t: 'subscribe', resource: 'conversation', id, lease: 'lease' })).toMatchObject({ id });
    expect(parseLiveSyncClientFrame({ t: 'unsubscribe', resource: 'conversation', id, lease: 'lease' })).toMatchObject({ id });
    expect(
      LiveSyncSubscribedFrameSchema.parse({
        t: 'subscribed',
        resource: 'conversation',
        id,
        lease: 'lease',
      }),
    ).toMatchObject({ id });
    expect(
      LiveSyncInvalidateFrameSchema.parse({
        t: 'invalidate',
        resource: 'conversation',
        id,
        through_message_id: 'opaque-watermark',
      }),
    ).toMatchObject({ id });
  });

  it.each(invalid)('rejects every frame kind for noncanonical identity %s', (id) => {
    expect(LiveSyncSubscribeFrameSchema.safeParse({ t: 'subscribe', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncUnsubscribeFrameSchema.safeParse({ t: 'unsubscribe', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncSubscribedFrameSchema.safeParse({ t: 'subscribed', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(
      LiveSyncInvalidateFrameSchema.safeParse({
        t: 'invalidate',
        resource: 'conversation',
        id,
        through_message_id: 'opaque-watermark',
      }).success,
    ).toBe(false);
  });
});

describe('live-sync scoped Cards contracts', () => {
  it.each(['children', 'detail', 'history', 'diff'] as const)('accepts the exact %s target', (scope) => {
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'cards', scope, card_id: 'card-a-b' }))
      .toEqual({ t: 'invalidate', resource: 'cards', scope, card_id: 'card-a-b' });
  });

  it.each(['brief.md', 'status.md', 'review.md'] as const)('accepts the exact record name %s', (record_name) => {
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'project', record_name }))
      .toEqual({ t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'project', record_name });
  });

  it.each([
    { t: 'invalidate', resource: 'cards' },
    { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: 'card-1' },
    { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: 'card-a', record_name: 'brief' },
    { t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'card-a' },
    { t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'card-a', slot: 'draft' },
  ])('rejects noncanonical Cards payload %#', (frame) => {
    expect(LiveSyncInvalidateFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe('live-sync unscoped wire contracts', () => {
  it.each(['runtime', 'timeline'] as const)('accepts the emitted %s invalidation', (resource) => {
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource })).toEqual({
      t: 'invalidate',
      resource,
    });
  });

  it.each(['files', 'processes'] as const)('rejects removed %s invalidations', (resource) => {
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(false);
  });
});

describe('known WebSocket parsers', () => {
  const connected = buildConnectedEnvelope({
    sessionId: 'agent:analyst:global',
    timestamp: '2026-07-24T00:00:00.000Z',
    clientCount: 1,
  });

  it('returns known valid content and envelopes', () => {
    expect(parseKnownWsContent(connected.content)).toEqual(connected.content);
    expect(parseKnownWsEnvelope(connected)).toEqual(connected);
  });

  it.each([
    undefined,
    {},
    { event: 'future_event' },
    { event: 'card_history_appended' },
  ])('throws for unknown, missing, or malformed known content %#', (content) => {
    expect(() => parseKnownWsContent(content)).toThrow();
  });

  it.each([
    undefined,
    {},
    { type: 'activity', content: { event: 'future_event' } },
    { type: 'activity', content: { event: 'card_history_appended' } },
  ])('throws for unknown, missing, or malformed known envelopes %#', (envelope) => {
    expect(() => parseKnownWsEnvelope(envelope)).toThrow();
  });
});
