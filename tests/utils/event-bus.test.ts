import { describe, expect, it, jest } from '@jest/globals';
import { EventBus, EventRegistry, getSeverity, toLoggedEvent } from '../../src/utils/event-bus.js';

describe('typed EventBus', () => {
  it('derives severity and known event metadata from the registry', () => {
    expect(EventRegistry.runtime_diagnostic.severity).toBe('error');
    expect(EventRegistry.subscriber_error.broadcast).toBe(false);
    expect(getSeverity('goal_completed')).toBe('info');
  });

  it('delivers typed events and supports subscribeMany filtering', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeMany(['goal_completed'], (event) => { seen.push(event.kind); });
    bus.emit('started', { project_root: '/tmp/project' });
    bus.emit('goal_completed', { goal_id: 'goal-1' });
    expect(seen).toEqual(['goal_completed']);
  });

  it('preserves pause/resume buffering with drop-oldest overflow', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const sub = bus.subscribe({
      bufferSize: 2,
      handler: (event) => { seen.push(String(event.payload.goal_id ?? event.kind)); },
    });
    sub.pause();
    bus.emit('goal_completed', { goal_id: 'one' });
    bus.emit('goal_completed', { goal_id: 'two' });
    bus.emit('goal_completed', { goal_id: 'three' });
    expect(bus.bufferedCount).toBe(2);
    sub.resume();
    expect(seen).toEqual(['two', 'three']);
  });

  it('isolates subscriber throws as subscriber_error and continues delivery', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('subscriber_error', (event) => { seen.push(`err:${event.payload.source_kind}`); });
    bus.subscribe('goal_completed', () => { throw new Error('boom'); });
    bus.subscribe('goal_completed', (event) => { seen.push(event.kind); });
    bus.emit('goal_completed', { goal_id: 'goal-1' });
    expect(seen).toEqual(['err:goal_completed', 'goal_completed']);
  });

  it('isolates subscriber timeouts as subscriber_error', () => {
    jest.useFakeTimers();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('subscriber_error', (event) => { seen.push(String(event.payload.timed_out)); });
    bus.subscribe({ deliveryTimeoutMs: 10, handler: async () => new Promise<void>(() => undefined) });
    bus.emit('goal_completed', { goal_id: 'goal-1' });
    jest.advanceTimersByTime(11);
    expect(seen).toEqual(['true']);
    jest.useRealTimers();
  });

  it('converts domain events to legacy logged-event records for transitional sinks', () => {
    const bus = new EventBus();
    let logged: Record<string, unknown> | null = null;
    bus.subscribe('goal_completed', (event) => { logged = toLoggedEvent(event); });
    bus.emit('goal_completed', { goal_id: 'goal-1' });
    expect(logged).toMatchObject({ kind: 'goal_completed', goal_id: 'goal-1' });
  });

  it('dispose unsubscribes and rejects later emits', () => {
    const bus = new EventBus();
    bus.subscribe('goal_completed', () => undefined);
    expect(bus.subscriberCount).toBe(1);
    bus.dispose();
    expect(bus.subscriberCount).toBe(0);
    expect(() => bus.emit('goal_completed', { goal_id: 'goal-1' })).toThrow('EventBus has been disposed');
  });
});
