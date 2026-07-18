import { cardRecordSchema, persistedCardRecordSchema } from '../../src/schemas/index.js';
import { enqueueCardNotification, removeCardNotifications } from '../../src/cards/lifecycle.js';

const base = {
  id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'code', parent: 'project', depth: 1, children: [],
  title: 'work', status: 'running', lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z', version_seq: 1, depends_on: [], related: [],
  pending_notifications: [{ id: 'n-1', content: 'new context', created_at: '2026-07-15T00:00:00.000Z', source: 'operator' }],
};

describe('card workflow contract', () => {
  test('requires strict pending notifications and hierarchical identity', () => {
    const parsed = cardRecordSchema.parse(base);
    expect(parsed.pending_notifications).toHaveLength(1);
    expect(parsed).not.toHaveProperty('position');
    expect(persistedCardRecordSchema.safeParse({ ...base, position: 0 }).success).toBe(false);
    expect(cardRecordSchema.safeParse({ ...base, id: 'card-1' }).success).toBe(false);
    const { pending_notifications: _pending, ...missing } = base;
    expect(cardRecordSchema.safeParse(missing).success).toBe(false);
    expect(cardRecordSchema.safeParse({ ...base, pending_notifications: [base.pending_notifications[0], base.pending_notifications[0]] }).success).toBe(false);
  });

  test.each(['done', 'failed', 'cancelled'] as const)('%s requires an empty queue', (status) => {
    expect(cardRecordSchema.safeParse({ ...base, status, lifecycle: { status, result: null, error: null, completed_at: null } }).success).toBe(false);
  });

  test.each(['backlog', 'changed', 'running', 'blocked'] as const)('%s preserves pending notifications', (status) => {
    const lifecycle = status === 'blocked'
      ? { status, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'later', blocker_cause: 'generic' }, error: 'blocked', completed_at: null }
      : { status, result: null, error: null, completed_at: null };
    expect(cardRecordSchema.safeParse({ ...base, status, lifecycle }).success).toBe(true);
  });

  test('enqueue and exact removal preserve order and unrelated notifications', () => {
    const parsed = cardRecordSchema.parse(base);
    const appended = enqueueCardNotification(parsed, { id: 'n-2', content: 'second', created_at: '2026-07-15T00:00:01.000Z' });
    expect(appended.pending_notifications.map((notification) => notification.id)).toEqual(['n-1', 'n-2']);
    expect(removeCardNotifications(appended, ['n-1']).pending_notifications.map((notification) => notification.id)).toEqual(['n-2']);
  });
});
import { describe, expect, test } from '@jest/globals';
