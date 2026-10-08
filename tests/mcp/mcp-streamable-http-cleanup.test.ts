import { createServer, type Server } from 'node:http';
import { describe, expect, it } from '@jest/globals';

import { invokeStreamableHttpTool } from '../../src/mcp/streamable-http-transport.js';

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
  it.each(['application/json', 'text/event-stream'])('preserves the exact caller reason and closes only its %s request', async contentType => {
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
      const observed = invokeStreamableHttpTool({ serverName: 'loopback', toolName: 'pending', args: {}, config: { transport: 'streamable-http', disabled: false, autostart: true, url: `http://127.0.0.1:${address.port}/mcp` }, handle: { abortController: serverController, streamableHttpSessionId: 'retained-session' }, timeoutMs: 5_000, ids: { next: () => 1 }, signal: caller.signal }).catch(error => error);
      await entered.promise;
      caller.abort(reason);
      expect(await within(observed, 5_000)).toBe(reason);
      await within(responseClosed.promise, 5_000);
      expect(serverController.signal.aborted).toBe(false);
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
