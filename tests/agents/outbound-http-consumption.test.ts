import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { consumeProviderRequest, ProviderInactivityTimeoutError, ProviderRequestDeadlineError } from '../../src/agents/llm-request-inactivity.js';
import { readOpenAICodexStream } from '../../src/agents/llm-codex-parser.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { controlledResponse, pendingHeaders } from '../helpers/provider-inactivity.js';
import { capturedHttp, deferred, microtasks, assertLifecycles, assertPrivateMetadata } from '../helpers/http-lifecycle.js';

const context = { service: 'provider', purpose: 'primary', endpoint: 'provider.chat', method: 'POST' } as const;
const codexContext = { ...context, endpoint: 'provider.codex' } as const;
const consumeCodex: Parameters<typeof consumeProviderRequest>[3] = (response, c) =>
  readOpenAICodexStream(response.body!, response.status, c.signal, c.onData, false, c.onBodyDisposition);
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
describe('provider-owned HTTP observation boundary', () => {
  it.each(['read', 'json', 'delta', 'done', 'eof', 'unowned-abort'] as const)(
    'reports the actual HTTP 200 Codex body disposition and code for %s', async mode => {
      const capture = capturedHttp();
      const reason = mode === 'unowned-abort'
        ? new DOMException('synthetic-private-abort', 'AbortError')
        : Object.assign(new Error('synthetic-private-native', { cause: { message: 'synthetic-private-cause' } }), { code: 'EPIPE' });
      const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'read' || mode === 'unowned-abort') controller.error(reason);
          else if (mode === 'eof') controller.close();
          else controller.enqueue(new TextEncoder().encode(mode === 'json'
            ? 'data: synthetic-private-json\n\n'
            : `data: ${JSON.stringify({ type: `response.function_call_arguments.${mode}`, item_id: 'synthetic-private-id', delta: '{}', arguments: '{}' })}\n\n`));
        },
      }), { status: 200 }));
      const pending = consumeProviderRequest('https://example.invalid', {}, undefined, consumeCodex, { context: codexContext, emitter: capture.sink });
      if (mode === 'unowned-abort') await expect(pending).rejects.toBe(reason);
      else await expect(pending).rejects.toMatchObject({ failure: { kind: mode === 'read' ? 'body_read_error' : 'parse_error' } });
      expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      assertLifecycles(capture.records, 1);
      expect(capture.records.at(-1)).toMatchObject({
        status: 200, outcome: 'failed', error_code: mode === 'read' ? 'body_read_error' : 'protocol',
        body_disposition: mode === 'eof' ? 'consumed' : 'incomplete',
      });
      assertPrivateMetadata(capture.records, ['EPIPE', 'synthetic-private-']);
    },
  );
  it.each(['owner', 'inactivity', 'unrelated'] as const)(
    'keeps the HTTP 200 Codex request-scope association for %s', async mode => {
      jest.useFakeTimers();
      const capture = capturedHttp();
      const owner = new AbortController();
      const reason = { exact: 'owner' };
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(new ReadableStream({
        start(c) {
          init!.signal!.addEventListener('abort', () => c.error(mode === 'unrelated'
            ? new Error('synthetic-private-native')
            : Object.assign(new Error('synthetic-private-abort'), { name: 'AbortError' })), { once: true });
        },
      }), { status: 200 }));
      const pending = consumeProviderRequest('https://example.invalid', {}, owner.signal, consumeCodex, { context: codexContext, emitter: capture.sink }).catch(e => e);
      await microtasks();
      expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers']);
      if (mode === 'inactivity') await jest.advanceTimersByTimeAsync(120_000);
      else owner.abort(reason);
      const result = await pending;
      if (mode === 'owner') expect(result).toBe(reason);
      else if (mode === 'inactivity') expect(result).toBeInstanceOf(ProviderInactivityTimeoutError);
      else expect(result).toMatchObject({ failure: { kind: 'body_read_error', status: 200 } });
      assertLifecycles(capture.records, 1);
      expect(capture.records.at(-1)).toMatchObject({
        status: 200, body_disposition: 'incomplete',
        outcome: mode === 'owner' ? 'cancelled' : mode === 'inactivity' ? 'timeout' : 'failed',
        error_code: mode === 'owner' ? 'owner_abort' : mode === 'inactivity' ? 'inactivity' : 'body_read_error',
      });
      assertPrivateMetadata(capture.records, ['synthetic-private-']);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it('propagates fatal Codex read uncertainty after headers without terminal or cleanup', async () => {
    jest.useFakeTimers();
    const capture = capturedHttp();
    const fatal = new PublicationOutcomeUnknownError();
    const owner = new AbortController();
    const remove = jest.spyOn(owner.signal, 'removeEventListener');
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.error(fatal); },
    }), { status: 200 }));
    await expect(consumeProviderRequest('https://example.invalid', {}, owner.signal, consumeCodex, { context: codexContext, emitter: capture.sink })).rejects.toBe(fatal);
    expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers']);
    expect(capture.records[1]).toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    // Discard the virtual clock without triggering the retained callbacks.
  });
  it.each(['success', 'failure', 'abort'] as const)('observes pending headers and body before %s settlement', async mode => {
    const capture = capturedHttp(); const headers = deferred<Response>(); const owner = new AbortController();
    const fetch = jest.spyOn(globalThis, 'fetch').mockReturnValue(headers.promise);
    const pending = consumeProviderRequest('https://secret-user:secret-pass@secret-host.invalid/secret-path?secret-query#secret-fragment',
      { method: 'POST', headers: { Authorization: 'secret-auth', Cookie: 'secret-cookie' }, body: 'secret-prompt-image' }, owner.signal,
      (response, consumption) => consumption.readText(response), { emitter: capture.sink, context }).catch(e => e);
    expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch']);
    const stream = controlledResponse(fetch.mock.calls[0]![1]!.signal!);
    Object.defineProperty(stream.response, 'redirected', { value: true });
    headers.resolve(stream.response); await microtasks();
    expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_headers']);
    expect(capture.records[1]).toMatchObject({ status: 200, request_id: capture.records[0]!.request_id });
    const failure = Object.assign(new Error('secret-nested-error'), { name: 'secret-name', code: 'secret-code', cause: { secret: 'secret-cause' } });
    if (mode === 'success') { stream.send('secret-response'); stream.close(); }
    else if (mode === 'failure') stream.error(failure);
    else owner.abort(failure);
    expect(await pending).toBe(mode === 'success' ? 'secret-response' : failure);
    assertLifecycles(capture.records, 1);
    expect(capture.records.at(-1)).toMatchObject({ outcome: mode === 'success' ? 'completed' : mode === 'abort' ? 'cancelled' : 'failed', body_disposition: mode === 'success' ? 'consumed' : 'incomplete' });
    expect(fetch.mock.calls[0]![1]!.redirect).toBeUndefined();
    assertPrivateMetadata(capture.records, ['secret-user', 'secret-pass', 'secret-host', 'secret-path', 'secret-query', 'secret-fragment', 'secret-auth', 'secret-cookie', 'secret-prompt-image', 'secret-response', 'secret-nested-error', 'secret-name', 'secret-code', 'secret-cause']);
  });
  it.each(['network', 'owner', 'inactivity'] as const)('classifies normalized no-response %s without inventing status', async mode => {
    jest.useFakeTimers(); const capture = capturedHttp(); const owner = new AbortController(); const reason = { exact: 'owner' };
    const network = new TypeError('secret-network');
    jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => mode === 'network' ? Promise.reject(network) : pendingHeaders(init!.signal!));
    const pending = consumeProviderRequest('https://example.invalid', {}, owner.signal, async () => '', { context, emitter: capture.sink }).catch(e => e);
    if (mode === 'owner') owner.abort(reason);
    if (mode === 'inactivity') await jest.advanceTimersByTimeAsync(120000);
    const result = await pending;
    if (mode === 'network') expect(result).toBe(network);
    else if (mode === 'inactivity') expect(result).toBeInstanceOf(ProviderInactivityTimeoutError);
    else expect(result).toBe(reason);
    expect(capture.records.map(r => r.event)).toEqual(['outbound_http_dispatch', 'outbound_http_terminal']);
    expect(capture.records.at(-1)).not.toHaveProperty('status');
    expect(capture.records.at(-1)).toMatchObject({ outcome: mode === 'network' ? 'failed' : mode === 'inactivity' ? 'timeout' : 'cancelled', error_code: mode === 'network' ? 'network' : mode === 'inactivity' ? 'inactivity' : 'owner_abort' });
    expect(jest.getTimerCount()).toBe(0);
    const before = capture.records.length;
    await expect(consumeProviderRequest('https://example.invalid', {}, AbortSignal.abort(reason), async () => '', { context, emitter: capture.sink })).rejects.toBe(reason);
    expect(capture.records).toHaveLength(before);
  });
  it('emits absolute deadline after active deferred body and not after headers alone', async () => {
    jest.useFakeTimers(); const capture = capturedHttp(); let stream!: ReturnType<typeof controlledResponse>;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { stream = controlledResponse(init!.signal!); return stream.response; });
    const pending = consumeProviderRequest('https://example.invalid', {}, undefined, (r, c) => c.readText(r), { context, emitter: capture.sink }).catch(e => e);
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 14; i++) { await jest.advanceTimersByTimeAsync(60000); stream.send(' '); await jest.advanceTimersByTimeAsync(0); expect(capture.records).toHaveLength(2); }
    await jest.advanceTimersByTimeAsync(60000);
    expect(await pending).toBeInstanceOf(ProviderRequestDeadlineError);
    expect(capture.records.at(-1)).toMatchObject({ outcome: 'timeout', error_code: 'deadline', body_disposition: 'incomplete' });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('terminal uses authoritative owner reason when a body reader rejects raw AbortError', async () => {
    const capture = capturedHttp(); const owner = new AbortController(); const reason = { exact: 'not-an-error' };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(c) {
      init!.signal!.addEventListener('abort', () => c.error(Object.assign(new Error('secret-raw-abort'), { name: 'AbortError' })), { once: true });
    } })));
    const pending = consumeProviderRequest('https://example.invalid', {}, owner.signal, (r, c) => c.readText(r), { context, emitter: capture.sink }).catch(e => e);
    await microtasks(); expect(capture.records).toHaveLength(2); owner.abort(reason);
    expect(await pending).toBe(reason); expect(capture.records.at(-1)).toMatchObject({ outcome: 'cancelled', error_code: 'owner_abort', status: 200 });
    assertPrivateMetadata(capture.records, ['secret-raw-abort']);
  });
  it.each([200, 503])('ordinary throwing sink preserves result, error identity and HTTP %s disposition', async status => {
    const failure = new Error('original'); const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    const emitter = jest.fn(() => { throw new Error('observer'); });
    const result = {};
    await expect(consumeProviderRequest('https://example.invalid', {}, undefined, async (_r, c) => { c.onBodyDisposition('not_consumed'); return result; }, { context, emitter })).resolves.toBe(result);
    await expect(consumeProviderRequest('https://example.invalid', {}, undefined, async () => { throw failure; }, { context, emitter })).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(2); expect(emitter).toHaveBeenCalledTimes(6);
  });
  it.each(['dispatch', 'headers', 'body'] as const)('publication uncertainty at %s permits no subsequent emission or cleanup', async stage => {
    jest.useFakeTimers(); const capture = capturedHttp(); const fatal = new PublicationOutcomeUnknownError(); const owner = new AbortController();
    const remove = jest.spyOn(owner.signal, 'removeEventListener'); const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(c) { if (stage === 'body') c.error(fatal); else c.close(); } })));
    const emitter = (event: Parameters<typeof capture.sink>[0]) => { capture.sink(event); if (event.event === `outbound_http_${stage}`) throw fatal; };
    await expect(consumeProviderRequest('https://example.invalid', {}, owner.signal, (r, c) => c.readText(r), { context, emitter })).rejects.toBe(fatal);
    expect(capture.records.map(r => r.event)).toEqual(stage === 'dispatch' ? ['outbound_http_dispatch'] : ['outbound_http_dispatch', 'outbound_http_headers']);
    expect(fetch).toHaveBeenCalledTimes(stage === 'dispatch' ? 0 : 1); expect(remove).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    // Discard virtual clock; do not trigger an uncertain owner's retained callbacks.
  });
});
