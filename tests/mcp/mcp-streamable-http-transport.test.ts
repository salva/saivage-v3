import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { discoverStreamableHttpTools, invokeStreamableHttpTool, readStreamableHttpJsonRpcResponse, probeStreamableHttpStartup } from '../../src/mcp/streamable-http-transport.js';
import { TransportError } from '../../src/mcp/errors.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { MCP_WIRE_RESPONSE_LIMIT_BYTES } from '../../src/mcp/protocol.js';

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function streamingSseResponse(input: {
  chunks?: string[];
  close?: boolean;
  cancel?: () => void | Promise<void>;
}): { response: Response; cancel: jest.Mock } {
  const cancel = jest.fn(input.cancel ?? (() => undefined));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of input.chunks ?? []) controller.enqueue(encoder.encode(chunk));
      if (input.close) controller.close();
    },
    cancel,
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    cancel,
  };
}

function sseData(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }
function sseResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(sseData(payload), { ...init, status: init.status ?? 200, headers: { 'content-type': 'text/event-stream', ...(init.headers as Record<string, string> | undefined) } });
}

describe('Streamable HTTP MCP transport', () => {
  const config = { transport: 'streamable-http' as const, disabled: false, autostart: false, url: 'http://localhost/mcp' };
  const discovery = (signal = new AbortController().signal) => {
    let id = 0;
    return discoverStreamableHttpTools({ serverName: 'srv', config, ids: { next: () => ++id }, signal });
  };
  it.each(['initialize', 'notifications/initialized', 'tools/list'])('classifies %s JSON-RPC and HTTP rejection at consumption', async stage => {
    for (const status of [200, 503]) {
      const methods: string[] = [];
      globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)); methods.push(request.method);
        if (request.method === stage) return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32002, message: 'secret-remote-text' } }), { status, headers: { 'content-type': 'application/json' } });
        if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const error = await discovery().catch(error => error);
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).toContain(stage);
      expect(error.message).toContain(status === 200 ? 'code -32002' : 'status 503');
      expect(error.message).not.toContain('secret-remote-text');
      expect(methods.at(-1)).toBe(stage);
    }
  });
  it('probe classifies only observed non-OK status and preserves unknown/cancellation identity', async () => {
    globalThis.fetch = jest.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(probeStreamableHttpStartup({ serverName: 'srv', config, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: expect.stringContaining('startup HEAD returned status 503') });
    for (const failure of [new TypeError('unknown fetch'), new PublicationOutcomeUnknownError()]) {
      globalThis.fetch = jest.fn(async () => { throw failure; }) as typeof fetch;
      await expect(probeStreamableHttpStartup({ serverName: 'srv', config, signal: new AbortController().signal })).rejects.toBe(failure);
      await expect(discovery()).rejects.toBe(failure);
    }
    const caller = new AbortController(); const reason = { exact: 'probe cancellation' };
    globalThis.fetch = jest.fn(async () => { caller.abort(reason); throw new TypeError('fetch aborted'); }) as typeof fetch;
    await expect(probeStreamableHttpStartup({ serverName: 'srv', config, signal: caller.signal })).rejects.toBe(reason);
  });
  it.each(['application/json', 'text/event-stream'])('preserves unknown %s body-read errors and skips all cleanup on publication uncertainty', async contentType => {
    for (const failure of [new Error('unknown reader'), new PublicationOutcomeUnknownError()]) {
      const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
      const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
      const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { headers: { 'content-type': contentType } });
      await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'tools/call', expectedId: 1 })).rejects.toBe(failure);
      expect(cancel).toHaveBeenCalledTimes(failure instanceof PublicationOutcomeUnknownError ? 0 : 1);
      expect(release).toHaveBeenCalledTimes(failure instanceof PublicationOutcomeUnknownError ? 0 : 1);
      jest.restoreAllMocks();
    }
  });
  it('does not relabel notification reader failures or continue discovery', async () => {
    for (const failure of [new Error('notification read'), new PublicationOutcomeUnknownError()]) {
      const methods: string[] = [];
      globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)); methods.push(request.method);
        if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
        return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      await expect(discovery()).rejects.toBe(failure);
      expect(methods).toEqual(['initialize', 'notifications/initialized']);
    }
  });
  it('retains typed malformed JSON and wrong-identity failures without raw body text', async () => {
    for (const bytes of ['secret-malformed-wire', JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} })]) {
      const response = new Response(bytes);
      const error = await readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'initialize', expectedId: 1 }).catch(error => error);
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).not.toContain('secret-malformed-wire');
      expect(response.body?.locked).toBe(false);
    }
  });
  it.each(['application/json', 'text/event-stream'])('preserves %s lock-release invariant identity', async contentType => {
    const failure = new Error('exact release invariant');
    const response = contentType === 'application/json'
      ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
      : sseResponse({ jsonrpc: '2.0', id: 1, result: {} });
    jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock').mockImplementation(() => { throw failure; });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'tools/call', expectedId: 1 })).rejects.toBe(failure);
    // Restore the real method and release this test-owned reader through its captured instance.
    const reader = (ReadableStreamDefaultReader.prototype.releaseLock as jest.Mock).mock.instances[0] as ReadableStreamDefaultReader;
    jest.restoreAllMocks();
    reader.releaseLock();
  });
  it('shared invocation reader preserves an unknown body failure rather than converting it to transport failure', async () => {
    const failure = new TypeError('exact invocation body-read failure');
    globalThis.fetch = jest.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(failure); } }))) as typeof fetch;
    await expect(invokeStreamableHttpTool({ serverName: 'srv', toolName: 'tool', args: {}, config, timeoutMs: 1000, ids: { next: () => 1 }, signal: new AbortController().signal })).rejects.toBe(failure);
  });
  it('publication uncertainty during body cancellation stops before lock release or further discovery', async () => {
    const failure = new PublicationOutcomeUnknownError();
    const methods: string[] = [];
    const release = jest.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)); methods.push(request.method);
      return streamingSseResponse({ chunks: [sseData({ jsonrpc: '2.0', id: request.id, result: {} })], cancel: () => Promise.reject(failure) }).response;
    }) as typeof fetch;
    await expect(discovery()).rejects.toBe(failure);
    expect(release).not.toHaveBeenCalled();
    expect(methods).toEqual(['initialize']);
    // No uncertain-stream follow-up, inspection or cleanup.
  });
  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('cancels and unlocks after reading a matching JSON-RPC response mid-stream', async () => {
    const { response, cancel } = streamingSseResponse({ chunks: [`: comment\n\ndata: {"jsonrpc":"2.0","id":99,"result":{}}\n\n${sseData({ jsonrpc: '2.0', id: 1, result: { ok: true } })}`] });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it.each([
    ['malformed data', 'data: {nope}\n\n', 'Malformed Streamable HTTP SSE data for op'],
    ['an oversized frame', `data: ${'x'.repeat(MCP_WIRE_RESPONSE_LIMIT_BYTES)}\n\n`, 'MCP SSE response exceeded 48 MiB'],
    ['an oversized buffer', 'x'.repeat(MCP_WIRE_RESPONSE_LIMIT_BYTES + 1), 'MCP SSE response exceeded 48 MiB'],
  ])('cancels and unlocks after rejecting %s', async (_name, chunk, message) => {
    const { response, cancel } = streamingSseResponse({ chunks: [chunk] });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).rejects.toThrow(message);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('reports a missing response and unlocks at EOF', async () => {
    const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
    const { response } = streamingSseResponse({ chunks: [': comment\n\n'], close: true });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).rejects.toThrow('Stream ended before JSON-RPC response for op');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('cancels a pending read on abort and leaves no reader lock', async () => {
    const controller = new AbortController();
    const { response, cancel } = streamingSseResponse({});
    const reading = readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1, signal: controller.signal });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('awaits cancellation before preserving the matched result and releasing the lock', async () => {
    const cancellation = deferred();
    const cancellationStarted = deferred();
    const { response } = streamingSseResponse({
      chunks: [sseData({ jsonrpc: '2.0', id: 1, result: { ok: true } })],
      cancel: () => {
        cancellationStarted.resolve();
        return cancellation.promise;
      },
    });
    let settled = false;
    const reading = readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 });
    void reading.finally(() => { settled = true; });

    await cancellationStarted.promise;
    expect(settled).toBe(false);
    expect(response.body?.locked).toBe(true);
    cancellation.resolve();
    await expect(reading).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(response.body?.locked).toBe(false);
  });

  it('preserves a matched result and unlocks when cancellation rejects', async () => {
    const { response } = streamingSseResponse({
      chunks: [sseData({ jsonrpc: '2.0', id: 1, result: { ok: true } })],
      cancel: () => Promise.reject(new Error('cancel failed')),
    });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(response.body?.locked).toBe(false);
  });

  it('preserves a parse error and unlocks when cancellation rejects', async () => {
    const { response } = streamingSseResponse({
      chunks: ['data: {nope}\n\n'],
      cancel: () => Promise.reject(new Error('cancel failed')),
    });
    await expect(readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 })).rejects.toThrow('Malformed Streamable HTTP SSE data for op');
    expect(response.body?.locked).toBe(false);
  });

  it('awaits cancellation before preserving a parse error and releasing the lock', async () => {
    const cancellation = deferred();
    const cancellationStarted = deferred();
    const { response } = streamingSseResponse({
      chunks: ['data: {nope}\n\n'],
      cancel: () => {
        cancellationStarted.resolve();
        return cancellation.promise;
      },
    });
    let settled = false;
    const reading = readStreamableHttpJsonRpcResponse(response, { serverName: 'srv', operation: 'op', expectedId: 1 });
    void reading.then(() => { settled = true; }, () => { settled = true; });

    await cancellationStarted.promise;
    expect(settled).toBe(false);
    expect(response.body?.locked).toBe(true);
    cancellation.resolve();
    await expect(reading).rejects.toThrow('Malformed Streamable HTTP SSE data for op');
    expect(response.body?.locked).toBe(false);
  });

  it('propagates session ids through initialize, notification, paginated list, and invocation', async () => {
    let id = 1;
    const handle: { abortController: AbortController; streamableHttpSessionId?: string } = { abortController: new AbortController() };
    const calls: any[] = [];
    (globalThis as any).fetch = jest.fn(async (_url: string, init?: any) => {
      calls.push(init);
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return sseResponse({ jsonrpc: '2.0', id: body.id, result: {} }, { headers: { 'Mcp-Session-Id': 'sess-1' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list' && !body.params?.cursor) return sseResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }], nextCursor: 'next' } });
      if (body.method === 'tools/list') return sseResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'two', inputSchema: { type: 'object' } }] } });
      return sseResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    });

    const tools = await discoverStreamableHttpTools({ serverName: 'srv', config: { transport: 'streamable-http', disabled: false, autostart: true, url: 'http://localhost/mcp' }, handle, ids: { next: () => id++ }, signal: new AbortController().signal });
    expect(tools.map((tool) => tool.name)).toEqual(['one', 'two']);
    expect(handle.streamableHttpSessionId).toBe('sess-1');
    const result = await invokeStreamableHttpTool({ serverName: 'srv', toolName: 'one', args: {}, config: { transport: 'streamable-http', disabled: false, autostart: true, url: 'http://localhost/mcp' }, handle, timeoutMs: 1000, ids: { next: () => id++ }, signal: new AbortController().signal });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(calls.filter((call) => call.body && JSON.parse(call.body).method !== 'initialize').every((call) => call.headers['Mcp-Session-Id'] === 'sess-1')).toBe(true);
  });
});
