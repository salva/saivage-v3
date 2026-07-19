import { describe, expect, it } from '@jest/globals';

import { acceptsCardNotifications, analystBriefEditEffect, canCancelCardStatus, canCreateChildInStatus } from '../../src/cards/card-api.js';
import type { CardStatus } from '../../src/schemas/index.js';

describe('card operation status decisions', () => {
  it.each([
    { status: 'backlog', create: true, cancel: true, notifications: true, brief: 'preserve' },
    { status: 'running', create: true, cancel: true, notifications: true, brief: 'preserve' },
    { status: 'blocked', create: true, cancel: true, notifications: true, brief: 'reopen' },
    { status: 'changed', create: true, cancel: true, notifications: true, brief: null },
    { status: 'stopped', create: true, cancel: true, notifications: true, brief: 'preserve' },
    { status: 'done', create: false, cancel: false, notifications: false, brief: 'reopen' },
    { status: 'failed', create: false, cancel: true, notifications: false, brief: 'reopen' },
    { status: 'cancelled', create: false, cancel: false, notifications: false, brief: null },
  ] satisfies Array<{ status: CardStatus; create: boolean; cancel: boolean; notifications: boolean; brief: 'preserve' | 'reopen' | null }>)(
    'defines all operation effects for $status',
    ({ status, create, cancel, notifications, brief }) => {
      expect(canCreateChildInStatus(status)).toBe(create);
      expect(canCancelCardStatus(status)).toBe(cancel);
      expect(acceptsCardNotifications(status)).toBe(notifications);
      expect(analystBriefEditEffect(status)).toBe(brief);
    },
  );
});
