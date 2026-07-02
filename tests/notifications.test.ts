import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/cards/card-store.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { getProjectNotificationCenter } from '../src/notifications/notification-delivery.js';
import { NotificationCenter } from '../src/notifications/notification-center.js';
import { queueNotification, resolveRecipient } from '../src/notifications/notification-triggers.js';
import { saveActorSnapshot } from '../src/runtime/actors/snapshots.js';
import type { CardRecord } from '../src/schemas/types.js';
import type { NewCardInput } from '../src/cards/lifecycle.js';

function makeCard(overrides: Partial<NewCardInput> & { id?: string; type: NewCardInput['type']; title: string }): NewCardInput & { id?: string } {
  return { parent: 'project', depth: 1, brief: overrides.title, status: 'backlog', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', assigned_to: null, depends_on: [], related: [], lifecycle: ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']), metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
}

function entry(kind: string, body = kind) {
  return { kind, body, queued_at: '2026-01-01T00:00:00.000Z', source_actor: 'runtime' as const, source_surface: 'runtime' as const };
}

function activeLlm(projectRoot: string, sessionId: string): void {
  saveActorSnapshot(projectRoot, { actor_id: sessionId, actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-01-01T00:00:00.000Z' });
}

describe('NotificationCenter queue semantics', () => {
  it('enqueues pending entries', () => {
    const center = new NotificationCenter('/tmp/unused');

    center.enqueue('session-1', entry('first'));
    center.enqueue('session-1', entry('second'));

    expect(center.queueLengthForSession('session-1')).toBe(2);
  });

  it('reports empty queues as zero length', () => {
    const center = new NotificationCenter('/tmp/unused');
    center.enqueue('session-1', entry('one'));

    expect(center.queueLengthForSession('session-1')).toBe(1);
    expect(center.queueLengthForSession('missing-session')).toBe(0);
  });

  it('drops the oldest entry when a recipient queue exceeds the retention bound', () => {
    const center = new NotificationCenter('/tmp/unused');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 65; i++) center.enqueue('session-1', entry(`kind-${i}`));

      expect(center.queueLengthForSession('session-1')).toBe(64);
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

  it('resolves and queues card recipients to card notification delivery and external sessions', () => {
    const goal = store.create(makeCard({ id: 'goal-1', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, depth: 2 }));
    activeLlm(projectRoot, `executor:${child.id}`);

    expect(resolveRecipient(projectRoot, store, child.id)).toEqual({ kind: 'card', cardId: child.id });
    const notifyCard = jest.fn();
    queueNotification(projectRoot, { kind: 'card', cardId: child.id }, 'card_changed', 'card body', { actor: 'runtime', surface: 'runtime' }, store, notifyCard);

    const center = getProjectNotificationCenter(projectRoot);
    expect(notifyCard).toHaveBeenCalledWith(child.id, expect.objectContaining({ message: 'card body', reason: 'card_changed' }));
    expect(center.queueLengthForSession(`executor:${child.id}`)).toBe(1);
  });

  it('resolves and queues role recipients to currently active matching sessions', () => {
    activeLlm(projectRoot, 'planner:project');
    activeLlm(projectRoot, 'executor:project');

    expect(resolveRecipient(projectRoot, store, 'planner')).toEqual({ kind: 'role', role: 'planner' });
    const notifyCard = jest.fn();
    queueNotification(projectRoot, { kind: 'role', role: 'planner' }, 'runtime_state', 'paused', { actor: 'runtime', surface: 'runtime' }, undefined, notifyCard);

    const center = getProjectNotificationCenter(projectRoot);
    expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ message: 'paused', reason: 'runtime_state' }));
    expect(center.queueLengthForSession('planner:project')).toBe(1);
    expect(center.queueLengthForSession('executor:project')).toBe(0);
  });

  it('resolves and queues explicit session recipients to exactly that session', () => {
    activeLlm(projectRoot, 'reviewer:project:assessment-1');

    expect(resolveRecipient(projectRoot, store, 'reviewer:project:assessment-1')).toEqual({ kind: 'session', sessionId: 'reviewer:project:assessment-1' });
    const notifyCard = jest.fn();
    queueNotification(projectRoot, { kind: 'session', sessionId: 'reviewer:project:assessment-1' }, 'review', 'please review', { actor: 'planner', surface: 'runtime' }, undefined, notifyCard);

    expect(notifyCard).toHaveBeenCalledWith('project', expect.objectContaining({ message: 'please review', reason: 'review' }));
    expect(getProjectNotificationCenter(projectRoot).queueLengthForSession('reviewer:project:assessment-1')).toBe(1);
  });

  it('returns null for an unknown recipient literal', () => {
    expect(resolveRecipient(projectRoot, store, 'missing-recipient')).toBeNull();
  });
});
