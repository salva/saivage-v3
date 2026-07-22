import { describe, expect, it } from '@jest/globals';

import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  LiveSyncSubscribeFrameSchema,
  LiveSyncUnsubscribeFrameSchema,
  parseLiveSyncClientFrame,
} from '../../src/contracts/operator-events.js';

const valid = ['agent:analyst:global', 'agent:planner:project', 'agent:reviewer:project', 'agent:executor:project'] as const;
const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;

describe('live-sync conversation identity contracts', () => {
  it.each(valid)('accepts every frame kind for exact identity %s', (id) => {
    expect(parseLiveSyncClientFrame({ t: 'subscribe', resource: 'conversation', id, lease: 'lease' })).toMatchObject({ id });
    expect(parseLiveSyncClientFrame({ t: 'unsubscribe', resource: 'conversation', id, lease: 'lease' })).toMatchObject({ id });
    expect(LiveSyncSubscribedFrameSchema.parse({ t: 'subscribed', resource: 'conversation', id, lease: 'lease' }).id).toBe(id);
    expect(LiveSyncInvalidateFrameSchema.parse({ t: 'invalidate', resource: 'conversation', id })).toMatchObject({ id });
  });

  it.each(invalid)('rejects every frame kind for noncanonical identity %s', (id) => {
    expect(LiveSyncSubscribeFrameSchema.safeParse({ t: 'subscribe', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncUnsubscribeFrameSchema.safeParse({ t: 'unsubscribe', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncSubscribedFrameSchema.safeParse({ t: 'subscribed', resource: 'conversation', id, lease: 'lease' }).success).toBe(false);
    expect(LiveSyncInvalidateFrameSchema.safeParse({ t: 'invalidate', resource: 'conversation', id }).success).toBe(false);
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
