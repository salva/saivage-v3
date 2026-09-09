import { describe, expect, it } from '@jest/globals';

import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  LiveSyncSubscribeFrameSchema,
  LiveSyncUnsubscribeFrameSchema,
  InboundAnalystMessageEnvelopeSchema,
  buildConnectedEnvelope,
  parseServerEgressWsEnvelope,
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
        segment_version: 1,
        visible_message_id: 'opaque-watermark',
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
        segment_version: 1,
        visible_message_id: 'opaque-watermark',
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
  it('accepts the runtime invalidation', () => {
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'runtime' })).toEqual({
      t: 'invalidate',
      resource: 'runtime',
    });
  });

  it.each(['timeline', 'files', 'processes'] as const)('rejects removed %s invalidations', (resource) => {
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource }).success).toBe(false);
  });
});

describe('server-egress WebSocket parser', () => {
  const connected = buildConnectedEnvelope({
    sessionId: 'agent:analyst:global',
    timestamp: '2026-07-24T00:00:00.000Z',
    clientCount: 1,
  });

  it('returns valid server envelopes', () => {
    expect(parseServerEgressWsEnvelope(connected)).toEqual(connected);
  });

  it('keeps strict browser-to-server Analyst input separate', () => {
    const input = { type: 'message', content: { text: 'Inspect the project.' } };
    expect(InboundAnalystMessageEnvelopeSchema.parse(input)).toEqual(input);
    expect(InboundAnalystMessageEnvelopeSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    expect(InboundAnalystMessageEnvelopeSchema.safeParse({
      ...input,
      content: { ...input.content, extra: true },
    }).success).toBe(false);
    expect(() => parseServerEgressWsEnvelope(input)).toThrow();
  });

  it.each([
    undefined,
    {},
    { type: 'activity', content: { event: 'future_event' } },
    { type: 'activity', content: { event: 'card_history_appended', card_id: 'project', version_seq: 2, changed_fields: ['pending_notifications'], changed_at: '2026-09-09T00:00:00.000Z' } },
    { type: 'message', content: { text: 'browser input only' } },
    { type: 'thinking', content: {} },
    { ...connected, extra: true },
    { ...connected, content: { ...connected.content, extra: true } },
  ])('throws for browser-input, unknown, extra, missing, or malformed server envelopes %#', (envelope) => {
    expect(() => parseServerEgressWsEnvelope(envelope)).toThrow();
  });
});
