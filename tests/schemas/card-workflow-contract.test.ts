import { describe, expect, test } from '@jest/globals';
import { cardOperatorSummarySchema, cardRecordSchema, type CardRecord, type CardStatus } from '../../src/schemas/index.js';
import { enqueueCardNotification, removeCardNotifications } from '../../src/cards/lifecycle.js';

const base: CardRecord = {
  id: 'card-a', type: 'code', children: [], title: 'work', subtype: null,
  lifecycle: { status: 'running', result: null, error: null, completed_at: null }, tags: [], priority: 0,
  urgency: 'normal', created_by: 'analyst', created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
  version_seq: 1, assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null,
  duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null,
  latest_self_report: null, metadata: null,
  pending_notifications: [{ id: 'n-1', content: 'new context', created_at: '2026-07-15T00:00:00.000Z', source: 'operator' }],
};
function lifecycleFor(status: CardStatus): CardRecord['lifecycle'] {
  if (status === 'done') return { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-15T00:00:01.000Z' };
  if (status === 'failed') return { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-15T00:00:01.000Z' };
  if (status === 'blocked') return { status, result: { kind: 'blocked', summary: 'blocked' }, error: 'blocked', completed_at: null };
  return { status, result: null, error: null, completed_at: null };
}

describe('card workflow contract', () => {
  test('requires every canonical key and rejects non-null null-only fields', () => {
    expect(cardRecordSchema.parse(base)).toEqual(base);
    const formerlyOptional = ['subtype', 'assigned_to', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text', 'status_text_updated_at', 'status_text_author_session_id', 'latest_self_report', 'metadata'] as const;
    for (const field of formerlyOptional) { const value = { ...base } as Record<string, unknown>; delete value[field]; expect(cardRecordSchema.safeParse(value).success).toBe(false); }
    const nullOnly = ['subtype', 'assigned_to', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text_author_session_id', 'latest_self_report', 'metadata'] as const;
    for (const field of nullOnly) expect(cardRecordSchema.safeParse({ ...base, [field]: field === 'duration_ms' ? 1 : 'value' }).success).toBe(false);
    expect(cardRecordSchema.safeParse({ ...base, status_text: 'terminal summary', status_text_updated_at: '2026-07-15T00:00:01.000Z' }).success).toBe(true);
  });

  test('rejects unproduced creator and broad operational lifecycle values', () => {
    expect(cardRecordSchema.safeParse({ ...base, created_by: 'user' }).success).toBe(false);
    for (const status of ['running', 'changed'] as const) {
      expect(cardRecordSchema.safeParse({ ...base, lifecycle: { status, result: { kind: 'done', summary: 'old' }, error: null, completed_at: null } }).success).toBe(false);
      expect(cardRecordSchema.safeParse({ ...base, lifecycle: { status, result: null, error: 'old', completed_at: null } }).success).toBe(false);
    }
    expect(cardRecordSchema.safeParse({ ...base, lifecycle: { status: 'cancelled', result: null, error: null, completed_at: '2026-07-15T00:00:01.000Z' }, pending_notifications: [] }).success).toBe(false);
  });

  test.each([
    ['backlog', true], ['changed', true], ['running', true], ['blocked', true], ['stopped', true], ['done', false], ['failed', false], ['cancelled', false],
  ] satisfies Array<[CardStatus, boolean]>)('%s notification admission is %s', (status, admits) => {
    const card = { ...base, lifecycle: lifecycleFor(status) };
    expect(cardRecordSchema.safeParse(card).success).toBe(admits);
    expect(cardRecordSchema.safeParse({ ...card, pending_notifications: [] }).success).toBe(true);
  });

  test('retains exact notification helpers and operator summary', () => {
    const appended = enqueueCardNotification(base, { id: 'n-2', content: 'second', created_at: '2026-07-15T00:00:01.000Z' });
    expect(appended.pending_notifications.map(({ id }) => id)).toEqual(['n-1', 'n-2']);
    expect(removeCardNotifications(appended, ['n-1']).pending_notifications.map(({ id }) => id)).toEqual(['n-2']);
    expect(() => removeCardNotifications(appended, [])).toThrow();
    expect(cardOperatorSummarySchema.parse({ blocked: true, hasError: true, error: 'blocked', completedAt: null, stale: false })).toEqual({ blocked: true, hasError: true, error: 'blocked', completedAt: null, stale: false });
  });
});
