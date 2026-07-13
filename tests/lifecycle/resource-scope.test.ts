import { describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceScope, ScopeDisposed } from '../../src/lifecycle/index.js';

// Probe whether the host has inotify/headroom to allocate an fs watcher.
// Long-running editors (e.g. VS Code) can saturate the system watch limit,
// causing ENOSPC on fs.watch() — an environment constraint, not a code bug.
let canAllocateFsWatcher = true;
try {
  const probe = fsWatch(tmpdir(), () => {});
  probe.close();
} catch {
  canAllocateFsWatcher = false;
}
const watchTest = canAllocateFsWatcher ? it : it.skip;

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

  watchTest('owns fs watchers and closes them during disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saivage-resource-scope-watch-'));
    try {
      const scope = createResourceScope('watcher');
      const events: string[] = [];
      const scopedWatch = scope.watch(dir, (eventType) => events.push(eventType), { name: 'tmp-watch' });
      const sawChange = new Promise<void>((resolve) => scopedWatch.watcher.once('change', () => resolve()));
      writeFileSync(join(dir, 'before-dispose.txt'), 'before');
      await sawChange;

      const closed = new Promise<void>((resolve) => scopedWatch.watcher.once('close', () => resolve()));
      await scope.dispose();
      await closed;

      const eventsBeforeSecondWrite = events.length;
      writeFileSync(join(dir, 'after-dispose.txt'), 'after');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(eventsBeforeSecondWrite).toBeGreaterThanOrEqual(1);
      expect(events).toHaveLength(eventsBeforeSecondWrite);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
