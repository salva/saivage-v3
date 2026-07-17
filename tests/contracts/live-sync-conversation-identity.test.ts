import { describe, expect, it } from '@jest/globals';

import {
  LiveSyncInvalidateFrameSchema,
  LiveSyncSubscribedFrameSchema,
  LiveSyncSubscribeFrameSchema,
  LiveSyncUnsubscribeFrameSchema,
  parseLiveSyncClientFrame,
} from '../../src/contracts/operator-events.js';

const valid = ['analyst:global', 'planner:project', 'reviewer:project', 'executor:project'] as const;
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
