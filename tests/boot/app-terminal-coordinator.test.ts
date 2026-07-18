import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { APP_CLEANUP_LEAF_TIMEOUT_MS, createAppTerminalCoordinator } from '../../src/boot/app.js';

describe('App terminal coordinator', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('closes every admission before cleanup and isolates fixed warnings', async () => {
    const terminal = createAppTerminalCoordinator();
    const calls: string[] = [];
    const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    terminal.registerAdmissionCloser('http-admission', () => { calls.push('http'); throw new Error('/secret/path token=secret'); });
    terminal.registerAdmissionCloser('runtime', () => { calls.push('runtime'); });
    terminal.registerCleanupLeaf('fastify', async () => { calls.push('fastify'); throw { payload: 'secret' }; });
    terminal.registerCleanupLeaf('live-sync', async () => { calls.push('live-sync'); });

    const report = await terminal.stop();

    expect(calls).toEqual(['http', 'runtime', 'live-sync', 'fastify']);
    expect(report).toEqual({ warnings: [
      { component: 'http-admission', code: 'closer_failed' },
      { component: 'fastify', code: 'cleanup_failed' },
    ] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.warnings)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('shares one report and continues after a bounded hanging leaf', async () => {
    jest.useFakeTimers();
    expect(APP_CLEANUP_LEAF_TIMEOUT_MS).toBe(10_000);
    const terminal = createAppTerminalCoordinator();
    const calls: string[] = [];
    terminal.registerCleanupLeaf('fastify', async () => { calls.push('later'); });
    terminal.registerCleanupLeaf('runtime', () => { calls.push('hanging'); return new Promise<void>(() => undefined); });

    const first = terminal.stop();
    const second = terminal.stop();
    const settled = jest.fn();
    void first.then(settled);
    expect(first).toBe(second);
    expect(calls).toEqual(['hanging']);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    expect(calls).toEqual(['hanging']);
    await jest.advanceTimersByTimeAsync(1);
    const report = await first;
    expect(report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_timeout' }] });
    expect(calls).toEqual(['hanging', 'later']);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(report);
    expect(await second).toBe(report);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the referenced timer after fast fulfillment and rejection', async () => {
    jest.useFakeTimers();
    for (const rejects of [false, true]) {
      const terminal = createAppTerminalCoordinator();
      terminal.registerCleanupLeaf('runtime', () => rejects ? Promise.reject(new Error('private')) : Promise.resolve());
      const before = jest.getTimerCount();
      const report = await terminal.stop();
      expect(jest.getTimerCount()).toBe(before);
      expect(report.warnings).toEqual(rejects ? [{ component: 'runtime', code: 'cleanup_failed' }] : []);
    }
  });
});
