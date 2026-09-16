import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { discoverStreamableHttpTools, invokeStreamableHttpTool, readStreamableHttpJsonRpcResponse } from '../../src/mcp/streamable-http-transport.js';
import { STREAMABLE_HTTP_SSE_BUFFER_LIMIT_BYTES, STREAMABLE_HTTP_SSE_FRAME_LIMIT_BYTES } from '../../src/mcp/protocol.js';

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
    ['an oversized frame', `data: ${'x'.repeat(STREAMABLE_HTTP_SSE_FRAME_LIMIT_BYTES)}\n\n`, 'Streamable HTTP op SSE frame exceeded limit'],
    ['an oversized buffer', 'x'.repeat(STREAMABLE_HTTP_SSE_BUFFER_LIMIT_BYTES + 1), 'Streamable HTTP op SSE buffer exceeded limit'],
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
    expect(result).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.filter((call) => call.body && JSON.parse(call.body).method !== 'initialize').every((call) => call.headers['Mcp-Session-Id'] === 'sess-1')).toBe(true);
  });
});
