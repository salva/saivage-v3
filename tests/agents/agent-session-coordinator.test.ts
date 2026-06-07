import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSessionCoordinator } from '../../src/agents/agent-session-coordinator.js';
import { appendMessage, createSession } from '../../src/agents/session-persistence.js';
import { SessionInvariantError } from '../../src/agents/session-invariant-error.js';

function notificationCenter() {
  return {
    drainPendingForSession: () => [],
  } as any;
}

describe('AgentSessionCoordinator', () => {
  it('owns cancellation state and emits cancellation events', () => {
    const bus = new EventEmitter();
    const events: unknown[] = [];
    bus.on('session_cancelled', (event) => events.push(event));
    const coordinator = new AgentSessionCoordinator({ saivageDir: '/tmp/unused', notificationCenter: notificationCenter(), eventBus: bus });
    const ctrl = new AbortController();

    coordinator.trackAbortController('session-1', ctrl);

    expect(coordinator.cancelSession('session-1')).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(coordinator.isCancelled('session-1')).toBe(true);
    expect(events).toEqual([{ session_id: 'session-1' }]);
  });

  it('force cancellation records inactive sessions without requiring an AbortController', () => {
    const coordinator = new AgentSessionCoordinator({ saivageDir: '/tmp/unused', notificationCenter: notificationCenter() });

    expect(coordinator.forceCancelSession('inactive-session')).toBe(false);
    expect(coordinator.isCancelled('inactive-session')).toBe(true);

    coordinator.clearCancellation('inactive-session');
    expect(coordinator.isCancelled('inactive-session')).toBe(false);
  });

  it('injects drained notifications ahead of persisted messages', () => {
    const center = {
      drainPendingForSession: () => [{ kind: 'operator', body: 'check this' }],
    } as any;
    const coordinator = new AgentSessionCoordinator({ saivageDir: '/tmp/not-a-session-dir', notificationCenter: center });

    const message = coordinator.buildNotificationInjectionMessage([{ kind: 'operator', body: 'check this' } as any], 'session-2');

    expect(message.id).toBe('msg-session-2-notification-injection');
    expect(message.content).toContain('[operator] check this');
  });

  it('filters model_issue diagnostics out of model messages but keeps model-visible system messages', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-session-coordinator-'));
    const saivageDir = join(root, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
    try {
      const session = createSession(saivageDir, 'planner', 'goal-1', 'goal-1', undefined, 'planner:goal-1');
      const stamp = { round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0 };
      appendMessage(saivageDir, session.id, { role: 'system', kind: 'model_issue', content: 'debug only' }, stamp);
      appendMessage(saivageDir, session.id, { role: 'system', kind: 'model_recovered', content: 'recover' }, { ...stamp, message_index: 1 });
      appendMessage(saivageDir, session.id, { role: 'system', kind: 'model_repair', content: 'repair' }, { ...stamp, message_index: 2 });
      appendMessage(saivageDir, session.id, { role: 'system', kind: 'context_compaction', content: 'compact' }, { ...stamp, message_index: 3 });
      appendMessage(saivageDir, session.id, { role: 'user', kind: 'text', content: 'continue' }, { ...stamp, message_index: 4 });

      const coordinator = new AgentSessionCoordinator({ saivageDir, notificationCenter: notificationCenter() });

      expect(coordinator.buildModelMessages(session.id).map((message) => message.kind)).toEqual([
        'model_recovered',
        'model_repair',
        'context_compaction',
        'text',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces handoff read corruption instead of treating it as absent handoff', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-session-coordinator-'));
    const saivageDir = join(root, '.saivage');
    mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
    mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
    try {
      const session = createSession(saivageDir, 'planner', 'goal-1', 'goal-1', undefined, 'planner:goal-1');
      writeFileSync(join(saivageDir, 'agents', 'messages', `${session.id}.jsonl`), '{not-json');
      const coordinator = new AgentSessionCoordinator({ saivageDir, notificationCenter: notificationCenter() });

      expect(() => coordinator.getHandoffSummary(session.id)).toThrow(SessionInvariantError);
      expect(() => coordinator.getActiveSessionHandoffs()).toThrow(SessionInvariantError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
