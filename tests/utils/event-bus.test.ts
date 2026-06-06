import { describe, expect, it, jest } from '@jest/globals';
import { EventBus, EventRegistry, agentEventKindValues, emitLoggedEvent, eventKindValues, getEventSeverity, runtimeEventKindValues, toLoggedEvent } from '../../src/events/index.js';

describe('typed EventBus', () => {
  it('derives severity and known event metadata from the registry', () => {
    expect(EventRegistry.runtime_diagnostic.severity).toBe('error');
    expect(EventRegistry.subscriber_error.broadcast).toBe(false);
    expect(getEventSeverity('goal_completed')).toBe('info');
  });

  it('derives disjoint runtime and agent event catalogs from registry domain metadata', () => {
    const runtimeKinds = new Set(runtimeEventKindValues);
    const agentKinds = new Set(agentEventKindValues);

    expect(EventRegistry.session_started.domain).toBe('agent');
    expect(EventRegistry.runtime_diagnostic.domain).toBe('runtime');
    expect(agentKinds.has('session_started')).toBe(true);
    expect(agentKinds.has('mcp_tool_invocation')).toBe(true);
    expect(runtimeKinds.has('runtime_diagnostic')).toBe(true);
    expect(runtimeKinds.has('goal_completed')).toBe(true);
    expect(runtimeEventKindValues.filter((kind) => agentKinds.has(kind))).toEqual([]);
    expect([...runtimeEventKindValues, ...agentEventKindValues].sort()).toEqual([...eventKindValues].sort());
  });

  it('delivers typed events and supports subscribeMany filtering', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeMany(['goal_completed'], (event) => { seen.push(event.kind); });
    bus.emit('started', { project_root: '/tmp/project' });
    bus.emit('goal_completed', { goal_id: 'goal-1' });
    expect(seen).toEqual(['goal_completed']);
  });

  it('validates typed emit payloads against the event registry schema', () => {
    const bus = new EventBus();
    expect(() => bus.emit('goal_completed', {} as never)).toThrow();
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

  it('re-emits logged-event records through the typed event bridge', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('goal_completed', (event) => { seen.push(event.payload.goal_id); });

    emitLoggedEvent(bus, { id: 'evt-1', kind: 'goal_completed', timestamp: new Date(0).toISOString(), goal_id: 'goal-1' });

    expect(seen).toEqual(['goal-1']);
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
