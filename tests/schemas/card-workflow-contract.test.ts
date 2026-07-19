import { cardOperatorSummarySchema, cardRecordSchema, persistedCardRecordSchema, type CardStatus } from '../../src/schemas/index.js';
import { enqueueCardNotification, removeCardNotifications } from '../../src/cards/lifecycle.js';

const base = {
  id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'code', parent: 'project', depth: 1, children: [],
  title: 'work', status: 'running', lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z', version_seq: 1, depends_on: [], related: [],
  pending_notifications: [{ id: 'n-1', content: 'new context', created_at: '2026-07-15T00:00:00.000Z', source: 'operator' }],
};

function lifecycleFor(status: CardStatus) {
  if (status === 'done') return { status, result: { kind: 'done' as const, summary: 'done' }, error: null, completed_at: '2026-07-15T00:00:01.000Z' };
  if (status === 'failed') return { status, result: { kind: 'failed' as const, summary: 'failed' }, error: 'failed', completed_at: '2026-07-15T00:00:01.000Z' };
  if (status === 'blocked') return { status, result: { kind: 'blocked' as const, summary: 'blocked', resume_reason: 'later', blocker_cause: 'generic' as const }, error: 'blocked', completed_at: null };
  if (status === 'cancelled') return { status, result: null, error: null, completed_at: '2026-07-15T00:00:01.000Z' };
  return { status, result: null, error: null, completed_at: null };
}

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

  test.each([
    ['backlog', true], ['changed', true], ['running', true], ['blocked', true],
    ['stopped', true], ['done', false], ['failed', false], ['cancelled', false],
  ] satisfies Array<[CardStatus, boolean]>)('%s pending-notification admission is %s', (status, admitsPendingNotification) => {
    const card = { ...base, status, lifecycle: lifecycleFor(status) };
    expect(cardRecordSchema.safeParse(card).success).toBe(admitsPendingNotification);
    expect(cardRecordSchema.safeParse({ ...card, pending_notifications: [] }).success).toBe(true);
  });

  test('card operator summary omits the removed terminal projection', () => {
    const summary = cardOperatorSummarySchema.parse({ lifecycleStatus: 'blocked', blocked: true, hasError: true, error: 'blocked', completedAt: null, stale: false, actionCount: 0 });
    expect(summary).toEqual({ lifecycleStatus: 'blocked', blocked: true, hasError: true, error: 'blocked', completedAt: null, stale: false, actionCount: 0 });
    expect(summary).not.toHaveProperty('terminal');
  });

  test('accepts only the exact stopped lifecycle shape', () => {
    const stopped = { ...base, status: 'stopped', lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } };
    expect(persistedCardRecordSchema.parse(stopped)).toMatchObject({ status: 'stopped', lifecycle: { status: 'stopped' } });
    expect(persistedCardRecordSchema.safeParse({ ...stopped, lifecycle: { ...stopped.lifecycle, error: 'old failure' } }).success).toBe(false);
    expect(persistedCardRecordSchema.safeParse({ ...stopped, lifecycle: { ...stopped.lifecycle, status: 'running' } }).success).toBe(false);
  });

  test('enqueue and exact removal preserve order and unrelated notifications', () => {
    const parsed = cardRecordSchema.parse(base);
    const appended = enqueueCardNotification(parsed, { id: 'n-2', content: 'second', created_at: '2026-07-15T00:00:01.000Z' });
    expect(appended.pending_notifications.map((notification) => notification.id)).toEqual(['n-1', 'n-2']);
    expect(removeCardNotifications(appended, ['n-1']).pending_notifications.map((notification) => notification.id)).toEqual(['n-2']);
  });
});
import { describe, expect, test } from '@jest/globals';
