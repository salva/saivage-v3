import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/cards/card-store.js';
import { createSession } from '../src/agents/session-persistence.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { getProjectNotificationCenter } from '../src/notifications/notification-delivery.js';
import { NotificationCenter } from '../src/notifications/notification-center.js';
import { queueNotification, resolveRecipient } from '../src/notifications/notification-triggers.js';
import type { CardRecord } from '../src/schemas/types.js';
import type { NewCardInput } from '../src/cards/lifecycle.js';

function makeCard(overrides: Partial<NewCardInput> & { id?: string; type: NewCardInput['type']; title: string }): NewCardInput & { id?: string } {
  return { parent: 'project', depth: 1, brief: overrides.title, status: 'backlog', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', assigned_to: null, depends_on: [], related: [], lifecycle: ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']), metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
}

function entry(kind: string, body = kind) {
  return { kind, body, queued_at: '2026-01-01T00:00:00.000Z', source_actor: 'runtime' as const, source_surface: 'runtime' as const };
}

describe('NotificationCenter queue semantics', () => {
  it('enqueues and drains pending entries in FIFO order', () => {
    const center = new NotificationCenter('/tmp/unused');

    center.enqueue('session-1', entry('first'));
    center.enqueue('session-1', entry('second'));

    expect(center.drainPendingForSession('session-1').map((item) => item.kind)).toEqual(['first', 'second']);
  });

  it('drains once and then vanishes from the in-memory queue', () => {
    const center = new NotificationCenter('/tmp/unused');
    center.enqueue('session-1', entry('one'));

    expect(center.drainPendingForSession('session-1')).toHaveLength(1);
    expect(center.drainPendingForSession('session-1')).toEqual([]);
    expect(center.queueLengthForSession('session-1')).toBe(0);
  });

  it('drops the oldest entry when a recipient queue exceeds the retention bound', () => {
    const center = new NotificationCenter('/tmp/unused');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 65; i++) center.enqueue('session-1', entry(`kind-${i}`));

      const drained = center.drainPendingForSession('session-1');
      expect(drained).toHaveLength(64);
      expect(drained[0].kind).toBe('kind-1');
      expect(drained.at(-1)?.kind).toBe('kind-64');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('notifications_overflow_dropped');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('queueNotification recipient resolution', () => {
  let projectRoot: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notifications-'));
    initProjectTree(projectRoot);
    store = new CardStore(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('resolves and queues card recipients to affected active sessions', () => {
    const goal = store.create(makeCard({ id: 'goal-1', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, depth: 2 }));
    createSession(join(projectRoot, '.saivage'), 'executor', goal.id, child.id, undefined, 'executor-session');

    expect(resolveRecipient(projectRoot, store, child.id)).toEqual({ kind: 'card', cardId: child.id });
    queueNotification(projectRoot, { kind: 'card', cardId: child.id }, 'card_changed', 'card body', { actor: 'runtime', surface: 'runtime' }, store);

    const center = getProjectNotificationCenter(projectRoot);
    expect(center.drainPendingForSession('executor-session')).toEqual([expect.objectContaining({ kind: 'card_changed', body: 'card body' })]);
  });

  it('resolves and queues role recipients to currently active matching sessions', () => {
    createSession(join(projectRoot, '.saivage'), 'planner', 'project', 'project', undefined, 'planner-session');
    createSession(join(projectRoot, '.saivage'), 'executor', 'project', 'project', undefined, 'executor-session');

    expect(resolveRecipient(projectRoot, store, 'planner')).toEqual({ kind: 'role', role: 'planner' });
    queueNotification(projectRoot, { kind: 'role', role: 'planner' }, 'runtime_state', 'paused', { actor: 'runtime', surface: 'runtime' });

    const center = getProjectNotificationCenter(projectRoot);
    expect(center.drainPendingForSession('planner-session')).toEqual([expect.objectContaining({ kind: 'runtime_state', body: 'paused' })]);
    expect(center.drainPendingForSession('executor-session')).toEqual([]);
  });

  it('resolves and queues explicit session recipients to exactly that session', () => {
    createSession(join(projectRoot, '.saivage'), 'reviewer', 'project', 'project', undefined, 'reviewer-session');

    expect(resolveRecipient(projectRoot, store, 'reviewer-session')).toEqual({ kind: 'session', sessionId: 'reviewer-session' });
    queueNotification(projectRoot, { kind: 'session', sessionId: 'reviewer-session' }, 'review', 'please review', { actor: 'planner', surface: 'runtime' });

    expect(getProjectNotificationCenter(projectRoot).drainPendingForSession('reviewer-session')).toEqual([expect.objectContaining({ kind: 'review', body: 'please review' })]);
  });

  it('returns null for an unknown recipient literal', () => {
    expect(resolveRecipient(projectRoot, store, 'missing-recipient')).toBeNull();
  });
});
