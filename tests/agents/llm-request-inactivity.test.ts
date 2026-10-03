import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createServer } from 'node:http';
import { consumeProviderRequest, ProviderInactivityTimeoutError } from '../../src/agents/llm-request-inactivity.js';
import { controlledResponse, pendingHeaders } from '../helpers/provider-inactivity.js';

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('request-local inactivity scope', () => {
  it.each(['success', 'fetch failure', 'callback failure'] as const)('clears timer and owner listener on %s, with inert late activity', async outcome => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const remove = jest.spyOn(owner.signal, 'removeEventListener');
    const failure = new TypeError('independent failure');
    let effective!: AbortSignal;
    let activity: (() => void) | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      effective = init!.signal!;
      if (outcome === 'fetch failure') throw failure;
      return new Response(null);
    });
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, async (response, context) => {
      activity = context.onData;
      if (outcome === 'callback failure') throw failure;
      return context.readText(response);
    });
    if (outcome === 'success') await expect(pending).resolves.toBe('');
    else await expect(pending).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledTimes(1);
    activity?.();
    await jest.advanceTimersByTimeAsync(240000);
    owner.abort(new Error('late owner'));
    expect(effective.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('expires pending headers at exactly 120000ms, using only its effective signal and removing owner listener', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const remove = jest.spyOn(owner.signal, 'removeEventListener');
    let effective!: AbortSignal;
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      effective = init!.signal!;
      return pendingHeaders(effective);
    });
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, async () => 'unused').catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(119999);
      expect(effective.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toBeInstanceOf(ProviderInactivityTimeoutError);
      expect(await pending).toBe(effective.reason);
      expect(owner.signal.aborted).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it('prevents already-aborted fetch and forwards owner cancellation during headers immediately', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const reason = new Error('owner stopped');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => pendingHeaders(init!.signal!));
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, async () => '').catch(error => error);
    try {
      owner.abort(reason);
      expect(jest.getTimerCount()).toBe(0);
      expect(await pending).toBe(reason);
      await expect(consumeProviderRequest('https://test.invalid', {}, owner.signal, async () => '')).rejects.toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it('prefers a racing owner only for the timeout path, not unrelated errors', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const reason = new Error('owner stopped');
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { owner.abort(reason); reject(init!.signal!.reason); }, { once: true });
    }));
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, async () => '').catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(120000);
      expect(await pending).toBe(reason);
      const otherOwner = new AbortController();
      const unrelated = new TypeError('network fault');
      jest.mocked(fetch).mockImplementation(async () => { otherOwner.abort(reason); throw unrelated; });
      await expect(consumeProviderRequest('https://test.invalid', {}, otherOwner.signal, async () => '')).rejects.toBe(unrelated);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it('consumes bytes over several windows with Response.text UTF-8/BOM semantics and releases its reader', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    let stream!: ReturnType<typeof controlledResponse>;
    let effective!: AbortSignal;
    let activity!: () => void;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      effective = init!.signal!; stream = controlledResponse(effective); return stream.response;
    });
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, async (response, context) => {
      activity = context.onData;
      return context.readText(response);
    });
    try {
      await jest.advanceTimersByTimeAsync(0);
      const chunks = [new Uint8Array([0xef]), new Uint8Array([0xbb, 0xbf, 0xc3]), new Uint8Array([0xa9, 0xff])];
      for (const chunk of chunks) { await jest.advanceTimersByTimeAsync(119000); stream.send(chunk); await jest.advanceTimersByTimeAsync(0); }
      stream.close();
      expect(await pending).toBe(await new Response(Buffer.concat(chunks)).text());
      expect(stream.response.body!.locked).toBe(false);
      activity();
      await jest.advanceTimersByTimeAsync(240000);
      expect(effective.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending.catch(() => {});
      stream?.close();
    }
  });

  it('empty chunks and headers do not renew body silence; callback rejection clears scope', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      stream = controlledResponse(init!.signal!); return stream.response;
    });
    const pending = consumeProviderRequest('https://test.invalid', {}, owner.signal, (response, context) => context.readText(response)).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(119000);
      stream.send(new Uint8Array());
      await jest.advanceTimersByTimeAsync(1000);
      expect(await pending).toBeInstanceOf(ProviderInactivityTimeoutError);
      expect(stream.response.body!.locked).toBe(false);
      const failure = new Error('parse failure');
      await expect(consumeProviderRequest('https://test.invalid', {}, owner.signal, async () => { stream.close(); throw failure; })).rejects.toBe(failure);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending;
    }
  });

  it.each(['headers', 'body'] as const)('aborts real Node fetch during %s with exact timeout and owner identities', async phase => {
    // Only the application timer is virtual; native socket/Undici scheduling remains real.
    const nativeFetch = globalThis.fetch;
    let observed!: () => void;
    let arrived = new Promise<void>(resolve => { observed = resolve; });
    const server = createServer((_request, response) => {
      if (phase === 'body') { response.writeHead(200); response.write('partial'); }
      observed();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP address');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'performance', 'queueMicrotask'] });
    let effective!: AbortSignal;
    jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      effective = init!.signal!; return nativeFetch(url, init);
    });
    try {
      for (const cancellation of ['timeout', 'owner'] as const) {
        const owner = new AbortController();
        const reason = new Error('native owner stopped');
        let consuming!: () => void;
        const bodyStarted = new Promise<void>(resolve => { consuming = resolve; });
        const pending = consumeProviderRequest(`http://127.0.0.1:${address.port}`, {}, owner.signal, async (response, context) => {
          consuming(); return context.readText(response);
        }).catch(error => error);
        try {
          await arrived;
          if (phase === 'body') await bodyStarted;
          if (cancellation === 'timeout') await jest.advanceTimersByTimeAsync(120000);
          else owner.abort(reason);
          const error = await pending;
          if (cancellation === 'timeout') expect(error).toBeInstanceOf(ProviderInactivityTimeoutError);
          else expect(error).toBe(reason);
          expect(error).toBe(effective.reason);
          expect(jest.getTimerCount()).toBe(0);
          arrived = new Promise<void>(resolve => { observed = resolve; });
        } finally {
          owner.abort(new Error('test cleanup'));
          await pending;
        }
      }
    } finally {
      jest.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
