import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createResourceScope, ScopeDisposed } from '../../src/lifecycle/index.js';

describe('ResourceScope', () => {
  it('disposes children before parent resources and parent resources in reverse registration order', async () => {
    const scope = createResourceScope('root');
    const order: string[] = [];
    scope.add({ dispose: () => { order.push('parent-a'); } }, { name: 'parent-a' });
    const child = scope.child('child');
    child.add({ dispose: () => { order.push('child-a'); } }, { name: 'child-a' });
    scope.add({ dispose: () => { order.push('parent-b'); } }, { name: 'parent-b' });

    const report = await scope.dispose();

    expect(order).toEqual(['child-a', 'parent-b', 'parent-a']);
    expect(report.errors).toEqual([]);
    expect(report.disposed.map((entry) => entry.name)).toEqual(['root/child', 'child-a', 'parent-b', 'parent-a']);
  });

  it('is idempotent and enforces disposed state', async () => {
    const scope = createResourceScope('idempotent');
    let disposed = 0;
    scope.add({ dispose: () => { disposed += 1; } }, { name: 'owned' });

    const first = await scope.dispose();
    const second = await scope.dispose();

    expect(disposed).toBe(1);
    expect(second).toBe(first);
    expect(scope.isDisposed()).toBe(true);
    expect(() => scope.add({ dispose: () => {} })).toThrow(ScopeDisposed);
    expect(() => scope.child('late')).toThrow(ScopeDisposed);
  });

  it('aggregates disposal failures and timeouts while continuing later resources', async () => {
    const scope = createResourceScope('errors', { disposeTimeoutMs: 25 });
    const order: string[] = [];
    scope.add({ dispose: () => { order.push('first'); } }, { name: 'first' });
    scope.add({ dispose: async () => { throw new Error('boom'); } }, { name: 'throws' });
    scope.add({ dispose: () => new Promise<void>(() => {}) }, { name: 'hangs', timeoutMs: 10 });
    scope.add({ dispose: () => { order.push('last'); } }, { name: 'last' });

    const report = await scope.dispose();

    expect(order).toEqual(['last', 'first']);
    expect(report.errors.map((entry) => entry.name).sort()).toEqual(['hangs', 'throws']);
    expect(report.disposed.map((entry) => entry.name)).toEqual(['last', 'hangs', 'throws', 'first']);
  });

  it('owns listeners and timers without handle introspection', async () => {
    const scope = createResourceScope('helpers');
    const emitter = new EventEmitter();
    const seen: unknown[][] = [];
    scope.on(emitter, 'event', (...args) => seen.push(args), { name: 'listener' });
    scope.setInterval(() => seen.push(['interval']), 10, { name: 'interval' });
    scope.setTimeout(() => seen.push(['timeout']), 10, { name: 'timeout' });

    emitter.emit('event', 'payload');
    await scope.dispose();
    emitter.emit('event', 'after-dispose');

    expect(seen).toEqual([['payload']]);
    expect(emitter.listenerCount('event')).toBe(0);
  });
});
