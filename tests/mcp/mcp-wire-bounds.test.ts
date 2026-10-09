import { expect, it } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { StdioMcpConnection } from '../../src/mcp/stdio-transport.js';
import { readStreamableHttpJsonRpcResponse } from '../../src/mcp/streamable-http-transport.js';
import { MCP_WIRE_RESPONSE_LIMIT_BYTES } from '../../src/mcp/protocol.js';

const context = { serverName: 'one', operation: 'tools/call', expectedId: 1 };
it.each(['application/json', 'text/event-stream'])('reads image-sized %s across UTF-8 chunk boundaries with exact correlation', async mime => {
  const text = 'é'.repeat(700_000);
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });
  const bytes = Buffer.from(mime === 'application/json' ? payload : `data: ${payload}\n\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let start = 0; start < bytes.length; start += 8191) controller.enqueue(bytes.subarray(start, start + 8191)); controller.close(); } });
  expect(await readStreamableHttpJsonRpcResponse(new Response(stream, { headers: { 'content-type': mime } }), context)).toEqual(JSON.parse(payload));
});
it('rejects oversized HTTP JSON before assembly and releases its reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.alloc(MCP_WIRE_RESPONSE_LIMIT_BYTES + 1, 120)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  await expect(readStreamableHttpJsonRpcResponse(response, context)).rejects.toThrow('48 MiB');
  expect(cancelled).toBe(true); expect(response.body?.locked).toBe(false);
});
it('rejects a complete HTTP response for the wrong call identity', async () => {
  await expect(readStreamableHttpJsonRpcResponse(new Response('{"jsonrpc":"2.0","id":2,"result":{}}'), context)).rejects.toThrow('wrong request identity');
});
it('bounds raw UTF-8 stdio frames before readline assembly and removes the pipe', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  stdin.once('data', () => { setImmediate(() => { const chunk = Buffer.from('é'.repeat(512 * 1024)); for (let n = 0; n < 49; n++) stdout.write(chunk); }); });
  const connection = new StdioMcpConnection({ serverName: 'one', stdin, stdout, ids: { next: () => 1 }, onFailure() {} });
  await expect(connection.invoke({ toolName: 'tool', args: {}, signal: new AbortController().signal, onResponse() {} })).rejects.toThrow('48 MiB');
  expect(stdout.listenerCount('data')).toBe(0);
  connection.dispose(new Error('test complete')); stdin.destroy(); stdout.destroy();
});
