import { createServer, type Server } from 'node:http';
import { describe, expect, it } from '@jest/globals';

import { discoverStreamableHttpTools, invokeStreamableHttpTool } from '../../src/mcp/streamable-http-transport.js';
import { TransportError } from '../../src/mcp/errors.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe('Streamable HTTP native fetch cleanup', () => {
  it.each([['application/json', 'invoke'], ['text/event-stream', 'invoke'], ['application/json', 'discovery'], ['text/event-stream', 'discovery']])('preserves the exact caller reason and closes only its %s %s request', async (contentType, operation) => {
    const entered = deferred<void>();
    const responseClosed = deferred<void>();
    const server = createServer((_request, response) => {
      response.once('close', () => responseClosed.resolve());
      response.writeHead(200, { 'content-type': contentType });
      response.write(contentType === 'application/json' ? '{' : ': waiting\n\n');
      entered.resolve();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected IP listener');
      const caller = new AbortController();
      const serverController = new AbortController();
      const reason = { exact: 'HTTP caller reason' };
      const input = { serverName: 'loopback', config: { transport: 'streamable-http' as const, disabled: false, autostart: true, url: `http://127.0.0.1:${address.port}/mcp` }, handle: { abortController: serverController, streamableHttpSessionId: 'retained-session' }, ids: { next: () => 1 }, signal: caller.signal };
      const observed = (operation === 'discovery' ? discoverStreamableHttpTools(input) : invokeStreamableHttpTool({ ...input, toolName: 'pending', args: {}, timeoutMs: 5_000 })).catch(error => error);
      await entered.promise;
      caller.abort(reason);
      expect(await within(observed, 5_000)).toBe(reason);
      await within(responseClosed.promise, 5_000);
      expect(serverController.signal.aborted).toBe(false);
    } finally { await closeServer(server); }
  });

  it('closes a keep-open discovery SSE rejection before returning and sends no later handshake request', async () => {
    const closed = deferred<void>(); const methods: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()); methods.push(body.method);
        response.once('close', () => closed.resolve());
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32007, message: 'secret SSE text' } })}\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected IP listener');
      const error = await discoverStreamableHttpTools({ serverName: 'loopback', config: { transport: 'streamable-http', disabled: false, autostart: false, url: `http://127.0.0.1:${address.port}/mcp` }, ids: { next: () => 1 }, signal: new AbortController().signal }).catch(error => error);
      expect(error).toBeInstanceOf(TransportError);
      expect(error.message).toContain('initialize rejected (code -32007)');
      expect(error.message).not.toContain('secret SSE text');
      await within(closed.promise, 5_000);
      expect(methods).toEqual(['initialize']);
    } finally { await closeServer(server); }
  });

  it('closes a keep-open SSE response after receiving the matching tool result', async () => {
    const responseClosed = deferred<{ writableEnded: boolean }>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      response.once('close', () => responseClosed.resolve({ writableEnded: response.writableEnded }));
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.once('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number | string };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an IP listener');
      const result = await invokeStreamableHttpTool({
        serverName: 'loopback',
        toolName: 'keep-open',
        args: {},
        config: { transport: 'streamable-http', disabled: false, autostart: true, url: `http://127.0.0.1:${address.port}/mcp` },
        timeoutMs: 5_000,
        ids: { next: () => 17 },
        signal: new AbortController().signal,
      });
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
      await expect(within(responseClosed.promise, 5_000)).resolves.toEqual({ writableEnded: false });
    } finally {
      await closeServer(server);
    }
  });
});
