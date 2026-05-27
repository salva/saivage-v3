import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';

import { AgentSessionCoordinator } from '../../src/agents/agent-session-coordinator.js';

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
});
