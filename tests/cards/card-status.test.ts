import { describe, expect, it } from '@jest/globals';

import { acceptsCardNotifications, analystRecordEditEffect, canCancelCardStatus, canCreateChildInStatus } from '../../src/cards/status-api.js';
import type { CardStatus } from '../../src/schemas/index.js';

describe('card operation status decisions', () => {
  it.each([
    { status: 'backlog', create: true, cancel: true, notifications: true, bootstrap_content: 'preserve' },
    { status: 'running', create: true, cancel: true, notifications: true, bootstrap_content: 'preserve' },
    { status: 'blocked', create: true, cancel: true, notifications: true, bootstrap_content: 'reopen' },
    { status: 'changed', create: true, cancel: true, notifications: true, bootstrap_content: null },
    { status: 'stopped', create: true, cancel: true, notifications: true, bootstrap_content: 'preserve' },
    { status: 'done', create: false, cancel: false, notifications: false, bootstrap_content: 'reopen' },
    { status: 'failed', create: false, cancel: true, notifications: false, bootstrap_content: 'reopen' },
    { status: 'cancelled', create: false, cancel: false, notifications: false, bootstrap_content: null },
  ] satisfies Array<{ status: CardStatus; create: boolean; cancel: boolean; notifications: boolean; bootstrap_content: 'preserve' | 'reopen' | null }>)(
    'defines all operation effects for $status',
    ({ status, create, cancel, notifications, bootstrap_content }) => {
      expect(canCreateChildInStatus(status)).toBe(create);
      expect(canCancelCardStatus(status)).toBe(cancel);
      expect(acceptsCardNotifications(status)).toBe(notifications);
      expect(analystRecordEditEffect(status)).toBe(bootstrap_content);
    },
  );
});
