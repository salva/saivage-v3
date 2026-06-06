import { describe, expect, it, jest } from '@jest/globals';
import {
  buildRuntimeDiagnosticEvent,
  RuntimeEventPublisher,
} from '../../src/runtime/runtime-event-publisher.js';
import { EventBus } from '../../src/events/bus.js';

describe('RuntimeEventPublisher diagnostics', () => {
  it('emits runtime diagnostics before durable append and appends once', () => {
    const order: string[] = [];
    const appendEvent = jest.fn((event: unknown) => {
      order.push('append');
      return event;
    });
    const publisher = new RuntimeEventPublisher({ appendEvent } as never, new EventBus());
    const seen: unknown[] = [];
    publisher.on('runtime_diagnostic', (payload) => {
      order.push('emit');
      seen.push(payload);
    });

    publisher.publishRuntimeDiagnostic({ goal_id: 'goal-a', phase: 'planner', error: new TypeError('boom') });

    expect(order).toEqual(['emit', 'append']);
    expect(seen).toEqual([
      expect.objectContaining({ goal_id: 'goal-a', phase: 'planner', error_message: 'boom', error_name: 'TypeError' }),
    ]);
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'runtime_diagnostic', goal_id: 'goal-a', phase: 'planner', error_message: 'boom', error_name: 'TypeError' }),
    );
  });

  it('swallows durable append failures after the event bus emit', () => {
    const appendEvent = jest.fn(() => { throw new Error('disk unavailable'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const publisher = new RuntimeEventPublisher({ appendEvent } as never, new EventBus());
    const seen: unknown[] = [];
    publisher.on('runtime_diagnostic', (payload) => { seen.push(payload); });

    expect(() => publisher.publishRuntimeDiagnostic({ card_id: 'card-a', phase: 'executor', error: 'boom' })).not.toThrow();

    expect(seen).toEqual([expect.objectContaining({ card_id: 'card-a', phase: 'executor', error_message: 'boom' })]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('builds EventLogger-ready diagnostic events for direct startup appends', () => {
    expect(buildRuntimeDiagnosticEvent({ phase: 'startup', error: new Error('reconciled run') })).toEqual({
      kind: 'runtime_diagnostic',
      phase: 'startup',
      error_message: 'reconciled run',
      error_name: 'Error',
    });
  });
});
