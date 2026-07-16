import { describe, expect, it, jest } from '@jest/globals';
import { EventBus, EventRegistry, agentEventKindValues, eventKindValues, getEventSeverity, runtimeEventKindValues, toEventLogRecord } from '../../src/events/index.js';

describe('typed EventBus', () => {
  it('derives severity and known event metadata from the registry', () => {
    expect(EventRegistry.runtime_diagnostic.severity).toBe('error');
    expect(EventRegistry.subscriber_error.broadcast).toBe(false);
    expect(getEventSeverity('card_history_appended')).toBe('info');
  });

  it('derives disjoint runtime and agent event catalogs from registry domain metadata', () => {
    const runtimeKinds = new Set(runtimeEventKindValues);
    const agentKinds = new Set(agentEventKindValues);

    expect(EventRegistry.mcp_tool_invocation.domain).toBe('agent');
    expect(EventRegistry.runtime_diagnostic.domain).toBe('runtime');
    expect(agentKinds.has('mcp_tool_invocation')).toBe(true);
    expect(runtimeKinds.has('runtime_diagnostic')).toBe(true);
    expect(runtimeKinds.has('card_history_appended')).toBe(true);
    expect(runtimeEventKindValues.filter((kind) => agentKinds.has(kind))).toEqual([]);
    expect([...runtimeEventKindValues, ...agentEventKindValues].sort()).toEqual([...eventKindValues].sort());
  });

  it('delivers typed events and supports subscribeMany filtering', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeMany(['runtime_diagnostic'], (event) => { seen.push(event.kind); });
    bus.emit('card_history_appended', { entry_id: '11111111-1111-4111-8111-111111111111', entry_kind: 'update', card_id: '22222222-2222-4222-8222-222222222222', version_seq: 1, changed_fields: [], changed_at: '2026-01-01T00:00:00.000Z' });
    bus.emit('runtime_diagnostic', { error_message: 'boom' });
    expect(seen).toEqual(['runtime_diagnostic']);
  });

  it('validates typed emit payloads against the event registry schema', () => {
    const bus = new EventBus();
    expect(() => bus.emit('runtime_diagnostic', {} as never)).toThrow();
  });

  it('preserves pause/resume buffering with drop-oldest overflow', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const sub = bus.subscribe('runtime_diagnostic', (event) => {
      seen.push(String(event.payload.goal_id ?? event.payload.error_message ?? event.kind));
    }, { bufferSize: 2 });
    sub.pause();
    bus.emit('runtime_diagnostic', { error_message: 'one' });
    bus.emit('runtime_diagnostic', { error_message: 'two' });
    bus.emit('runtime_diagnostic', { error_message: 'three' });
    expect(bus.bufferedCount).toBe(2);
    sub.resume();
    expect(seen).toEqual(['two', 'three']);
  });

  it('isolates subscriber throws as subscriber_error and continues delivery', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('subscriber_error', (event) => { seen.push(`err:${event.payload.source_kind}`); });
    bus.subscribe('runtime_diagnostic', () => { throw new Error('boom'); });
    bus.subscribe('runtime_diagnostic', (event) => { seen.push(event.kind); });
    bus.emit('runtime_diagnostic', { error_message: 'boom' });
    expect(seen).toEqual(['err:runtime_diagnostic', 'runtime_diagnostic']);
  });

  it('isolates subscriber timeouts as subscriber_error', () => {
    jest.useFakeTimers();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('subscriber_error', (event) => { seen.push(String(event.payload.timed_out)); });
    bus.subscribe({ deliveryTimeoutMs: 10, handler: async () => new Promise<void>(() => undefined) });
    bus.emit('runtime_diagnostic', { error_message: 'boom' });
    jest.advanceTimersByTime(11);
    expect(seen).toEqual(['true']);
    jest.useRealTimers();
  });

  it('projects domain events to flattened event-log records', () => {
    const bus = new EventBus();
    let logged: Record<string, unknown> | null = null;
    bus.subscribe('runtime_diagnostic', (event) => { logged = toEventLogRecord(event); });
    bus.emit('runtime_diagnostic', { error_message: 'boom', goal_id: '11111111-1111-4111-8111-111111111111' });
    expect(logged).toMatchObject({ kind: 'runtime_diagnostic', goal_id: '11111111-1111-4111-8111-111111111111', error_message: 'boom' });
  });

  it('dispose unsubscribes and rejects later emits', () => {
    const bus = new EventBus();
    bus.subscribe('runtime_diagnostic', () => undefined);
    expect(bus.subscriberCount).toBe(1);
    bus.dispose();
    expect(bus.subscriberCount).toBe(0);
    expect(() => bus.emit('runtime_diagnostic', { error_message: 'boom' })).toThrow('EventBus has been disposed');
  });
});
