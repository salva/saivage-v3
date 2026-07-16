import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';
import { TelegramBot } from '../../src/telegram/bot.js';

const config = { models: { default: ['test'] }, providers: {}, runtime: { continuous_improvement: false }, telegram: { botToken: 'test', allowedUserIds: [1] } } as never;
const analyst = { submit: jest.fn() } as never;

describe('TelegramBot terminal stop', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('propagates one opaque lifecycle reason by identity and normalizes only it', async () => {
    let observedReason: unknown;
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => { observedReason = signal.reason; reject(signal.reason); }, { once: true });
    }));
    const bot = new TelegramBot('/project', analyst, config);
    await bot.start();
    const stop = bot.stop();
    expect(bot.isRunning()).toBe(false);
    await expect(stop).resolves.toBeUndefined();
    expect(observedReason).toBeDefined();

    let secondReason: unknown;
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => { secondReason = signal.reason; reject(signal.reason); }, { once: true });
    }));
    await bot.start();
    await bot.stop();
    expect(secondReason).not.toBe(observedReason);
  });

  it('reports a distinct rejection racing after abort as cleanup_failed', async () => {
    const sentinel = Object.freeze({ failure: 'poll' });
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => queueMicrotask(() => reject(sentinel)), { once: true });
    }));
    const bot = new TelegramBot('/project', analyst, config);
    await bot.start();
    const terminal = createAppTerminalCoordinator();
    terminal.registerAdmissionCloser('telegram', () => bot.closeAdmission());
    terminal.registerCleanupLeaf('telegram', () => bot.stop());
    await expect(terminal.stop()).resolves.toEqual({ warnings: [{ component: 'telegram', code: 'cleanup_failed' }] });
  });

  it('stops successfully from the real retry backoff with the exact lifecycle reason', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    let pollSignal: AbortSignal | undefined;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      pollSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ ok: false, description: 'temporary', error_code: 500 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    const bot = new TelegramBot('/project', analyst, config);
    await bot.start();
    for (let attempt = 0; attempt < 20 && jest.getTimerCount() === 0; attempt += 1) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    const stop = bot.stop();
    const reason = pollSignal?.reason;
    expect(reason).toBeDefined();
    expect(bot.isRunning()).toBe(false);
    await expect(stop).resolves.toBeUndefined();
    expect(pollSignal?.reason).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('maps a real abort-ignoring poll to the exact ten-second timeout and continues', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    const bot = new TelegramBot('/project', analyst, config);
    await bot.start();
    const calls: string[] = [];
    const terminal = createAppTerminalCoordinator();
    terminal.registerCleanupLeaf('fastify', () => { calls.push('later'); });
    terminal.registerAdmissionCloser('telegram', () => { calls.push('close'); bot.closeAdmission(); });
    terminal.registerCleanupLeaf('telegram', () => { calls.push('telegram'); return bot.stop(); });

    const stopped = terminal.stop();
    expect(calls).toEqual(['close', 'telegram']);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(calls).toEqual(['close', 'telegram']);
    await jest.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toEqual({ warnings: [{ component: 'telegram', code: 'cleanup_timeout' }] });
    expect(calls).toEqual(['close', 'telegram', 'later']);
  });
});
