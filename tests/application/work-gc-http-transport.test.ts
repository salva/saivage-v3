import { afterEach, expect, it } from '@jest/globals';
import { createServer, type Server, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { OperatorRuntimeHttpClient } from '../../src/application/operator-runtime-http-client.js';
import { deferred } from '../../src/runtime/actors/deferred.js';

let server: Server | undefined;
const originalToken = process.env.SAIVAGE_API_TOKEN;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
  if (originalToken === undefined) delete process.env.SAIVAGE_API_TOKEN;
  else process.env.SAIVAGE_API_TOKEN = originalToken;
});
async function listen(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, auth: 'disabled' as const };
}
const response = { mode: 'dry_run', disposition: 'refused', reason: 'maintenance_refused', restoration: 'not_acquired', result: null };

it('uses the selected Undici request with zero header/body deadlines, waits for delayed headers and split body, and closes its socket', async () => {
  const entered = deferred<void>(), headers = deferred<void>(), body = deferred<void>(), closed = deferred<void>();
  let requestCount = 0;
  const endpoint = await listen(async (request, reply) => {
    requestCount++;
    expect(request.url).toBe('/api/runtime/gc-work');
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe('Bearer synthetic-token');
    request.socket.once('close', () => closed.resolve());
    entered.resolve(); await headers.promise;
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.write(JSON.stringify(response).slice(0, 20));
    await body.promise; reply.end(JSON.stringify(response).slice(20));
  });
  const observed: Array<{ headersTimeout: number; bodyTimeout: number }> = [];
  const creation = channel('undici:request:create');
  const observe = (message: unknown) => { observed.push((message as { request: typeof observed[number] }).request); };
  creation.subscribe(observe);
  process.env.SAIVAGE_API_TOKEN = 'synthetic-token';
  let settled = false;
  const call = new OperatorRuntimeHttpClient().gcWork({ ...endpoint, auth: 'bearer' }, { mode: 'dry_run' }).finally(() => { settled = true; });
  try {
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
    headers.resolve();
    await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
    body.resolve();
    await expect(call).resolves.toEqual(response);
    await closed.promise;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
    expect(requestCount).toBe(1);
  } finally { creation.unsubscribe(observe); headers.resolve(); body.resolve(); }
});

it.each([
  ['auth', 401, '{"message":"unauthorized"}', /unauthorized/],
  ['busy', 409, '{"message":"Work garbage collection is busy."}', /busy/],
  ['redirect', 302, '{}', /HTTP 302/],
  ['non-JSON', 200, 'private-not-json', /malformed JSON/],
  ['invalid contract', 200, '{}', /did not match/],
] as const)('fails %s once without redirect, retry or fetch fallback', async (_name, status, text, error) => {
  let count = 0;
  const endpoint = await listen((_request, reply) => { count++; reply.writeHead(status, { location: '/redirect-target' }); reply.end(text); });
  await expect(new OperatorRuntimeHttpClient(() => { throw new Error('fetch must not run'); }).gcWork(endpoint, { mode: 'dry_run' })).rejects.toThrow(error);
  expect(count).toBe(1);
});

it.each(['before headers', 'truncated body'] as const)('distinguishes %s transport failure from malformed JSON and does not retry', async mode => {
  let count = 0;
  const endpoint = await listen((_request, reply) => {
    count++;
    if (mode === 'before headers') reply.destroy();
    else { reply.writeHead(200, { 'content-length': '1000' }); reply.write('{'); setImmediate(() => reply.destroy()); }
  });
  await expect(new OperatorRuntimeHttpClient().gcWork(endpoint, { mode: 'dry_run' })).rejects.toThrow('transport or response body read failed');
  expect(count).toBe(1);
});

it('explicit cancellation disconnects an unsettled response and releases the owned transport', async () => {
  const entered = deferred<void>(), closed = deferred<void>();
  const endpoint = await listen((request) => { request.socket.once('close', () => closed.resolve()); entered.resolve(); });
  const abort = new AbortController();
  const call = new OperatorRuntimeHttpClient().gcWork(endpoint, { mode: 'dry_run' }, abort.signal);
  await entered.promise; abort.abort();
  await expect(call).rejects.toThrow('transport or response body read failed');
  await closed.promise;
});
