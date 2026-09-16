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
      expect(result).toEqual([{ type: 'text', text: 'ok' }]);
      await expect(within(responseClosed.promise, 5_000)).resolves.toEqual({ writableEnded: false });
    } finally {
      await closeServer(server);
    }
  });
});
