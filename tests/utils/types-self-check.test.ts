import { describe, it, expect } from '@jest/globals';

import type { SelfCheckTriggeredEvent, AgentRole } from '../../src/schemas/types.js';

describe('SelfCheckTriggeredEvent type', () => {
  function makeEvent(overrides?: Partial<SelfCheckTriggeredEvent>): SelfCheckTriggeredEvent {
    return {
      id: 'evt-self-check-001',
      kind: 'self_check_triggered',
      timestamp: '2026-05-11T12:00:00.000Z',
      session_id: 'sess-exec-001',
      role: 'executor',
      rounds: 15,
      threshold: 15,
      response: null,
      ...overrides,
    };
  }

  it('can be constructed with all required fields', () => {
    const event = makeEvent();
    expect(event).toBeDefined();
    expect(event.id).toBe('evt-self-check-001');
    expect(event.kind).toBe('self_check_triggered');
    expect(event.timestamp).toBe('2026-05-11T12:00:00.000Z');
    expect(event.session_id).toBe('sess-exec-001');
    expect(event.role).toBe('executor');
    expect(event.rounds).toBe(15);
    expect(event.threshold).toBe(15);
    expect(event.response).toBeNull();
  });

  it('has kind === "self_check_triggered"', () => {
    const event = makeEvent();
    // TypeScript narrows `kind` to the literal, but we double-check at runtime
    expect(event.kind).toBe('self_check_triggered');
  });

  it('session_id field exists and is a string', () => {
    const event = makeEvent({ session_id: 'sess-planner-042' });
    expect(typeof event.session_id).toBe('string');
    expect(event.session_id).toBe('sess-planner-042');
  });

  it('role field exists and accepts valid AgentRole values', () => {
    const roles: AgentRole[] = ['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor'];
    for (const role of roles) {
      const event = makeEvent({ role });
      expect(event.role).toBe(role);
    }
  });

  it('rounds field exists and is a number', () => {
    const event = makeEvent({ rounds: 30 });
    expect(typeof event.rounds).toBe('number');
    expect(event.rounds).toBe(30);
  });

  it('threshold field exists and is a number', () => {
    const event = makeEvent({ threshold: 15 });
    expect(typeof event.threshold).toBe('number');
    expect(event.threshold).toBe(15);
  });

  it('response field exists and can be a string or null', () => {
    const withNull = makeEvent({ response: null });
    expect(withNull.response).toBeNull();

    const withString = makeEvent({ response: 'Making steady progress on the task.' });
    expect(typeof withString.response).toBe('string');
    expect(withString.response).toBe('Making steady progress on the task.');

    // response is optional via `?`, so omitting it yields undefined at runtime
    const withoutResponse = makeEvent();
    // Use a type-safe spread to test the optional property
    const { response: _r, ...rest } = withoutResponse;
    expect((rest as typeof withoutResponse).response).toBeUndefined();
  });

  it('can represent a planner self-check at 30 rounds', () => {
    const event = makeEvent({
      session_id: 'sess-planner-001',
      role: 'planner',
      rounds: 30,
      threshold: 30,
      response: 'Plan is on track, no adjustments needed.',
    });

    expect(event.kind).toBe('self_check_triggered');
    expect(event.role).toBe('planner');
    expect(event.rounds).toBe(30);
    expect(event.threshold).toBe(30);
    expect(event.response).toBe('Plan is on track, no adjustments needed.');
  });
});
