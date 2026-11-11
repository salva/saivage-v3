import { afterEach, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkGcBusyError, WorkGcResponseSchema, type WorkGcResponse } from '../../src/contracts/index.js';
import { workGcOperatorApiContracts } from '../../src/contracts/operator-api-work-gc.js';
import { buildWorkGcOperatorContractHandlers } from '../../src/server/routes/operator-work-gc-handlers.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createEventLog } from '../../src/observability/index.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { ContractFrameStream } from '../../src/server/contract-stream.js';
import { WorkGcFrameSchema } from '../../src/contracts/work-gc.js';
import { WorkGcStreamDecoder } from '../../src/contracts/work-gc-stream.js';
import { deferred } from '../../src/runtime/actors/deferred.js';

let app: FastifyInstance | undefined;
let root: string | undefined;
afterEach(async () => { await app?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
const refusal: WorkGcResponse = { mode: 'dry_run', disposition: 'refused',
  reason: 'maintenance_refused', restoration: 'not_acquired', failure: { code: 'EIO', syscall: 'read' }, result: null };
it('strict route authenticates, rejects invalid filters and maps duplicate GC to busy without invoking twice', async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-routes-'));
  app = Fastify({ logger: false });
  const collect = jest.fn<RuntimeApplication['collectWorkGarbage']>().mockResolvedValue(refusal);
  const handlers = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication);
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'gc-test' }),
    eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort })
    .mount(app, workGcOperatorApiContracts, handlers);
  const request = { method: 'POST' as const, url: '/api/runtime/gc-work', payload: { mode: 'dry_run' } };
  expect((await app.inject(request)).statusCode).toBe(401);
  const headers = { authorization: 'Bearer gc-test' };
  expect((await app.inject({ ...request, headers, payload: { mode: 'dry_run', delete: true } })).statusCode).toBe(400);
  expect((await app.inject({ ...request, headers, payload: { mode: 'dry_run', before: '2026-10-24T00:00:00+9900' } })).statusCode).toBe(400);
  expect(collect).not.toHaveBeenCalled();
  const response = await app.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('application/x-ndjson');
  const decoder = new WorkGcStreamDecoder(response.headers['content-type'] as string);
  decoder.push(Buffer.from(response.body));
  expect(WorkGcResponseSchema.parse(decoder.finish())).toEqual(refusal);
  collect.mockImplementation(() => { throw new WorkGcBusyError(); });
  expect((await app.inject({ ...request, headers })).json()).toEqual({ error: 'WorkGcBusy', message: 'Work garbage collection is busy.' });
  expect(collect).toHaveBeenCalledTimes(2);
});
it('disconnect cancels the running request signal rather than any accepted turn owner', async () => {
  const raw = new EventEmitter();
  const reply = new EventEmitter();
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const collect = jest.fn<RuntimeApplication['collectWorkGarbage']>(async (_body, signal) => {
    entered();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { ...refusal, reason: 'cancelled', failure: null };
  });
  const handler = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication)['runtime.gcWork'];
  const stream = new ContractFrameStream(WorkGcFrameSchema);
  const task = handler({ body: { mode: 'dry_run' }, request: { raw }, reply: { raw: reply, createStream: () => stream } } as unknown as Parameters<typeof handler>[0]);
  await entry;
  reply.emit('close');
  expect(await task).toMatchObject({ stream: stream.body });
  await new Promise(resolve => setImmediate(resolve));
  expect(collect.mock.calls[0]![1].aborted).toBe(true);
  expect(raw.listenerCount('aborted')).toBe(0);
  expect(reply.listenerCount('close')).toBe(0);
});
it('sends declared headers before deferred inventory or final response can settle', async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-early-headers-'));
  app = Fastify({ logger: false });
  const completion = deferred<WorkGcResponse>();
  const collect = jest.fn<RuntimeApplication['collectWorkGarbage']>(() => completion.promise);
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'gc-test' }),
    eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort })
    .mount(app, workGcOperatorApiContracts,
      buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${origin}/api/runtime/gc-work`, { method: 'POST',
      headers: { authorization: 'Bearer gc-test', 'content-type': 'application/json' },
      body: '{"mode":"dry_run"}', signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    completion.resolve(refusal);
    const decoder = new WorkGcStreamDecoder(response.headers.get('content-type'));
    decoder.push(new Uint8Array(await response.arrayBuffer()));
    expect(decoder.finish()).toEqual(refusal);
  } finally { completion.resolve(refusal); }
});
it('bypasses transport reporting and cleanup after an injected throwing fatal port', async () => {
  const raw = new EventEmitter(), reply = new EventEmitter();
  const stream = new ContractFrameStream(WorkGcFrameSchema);
  const destroy = jest.spyOn(stream.body, 'destroy');
  const finish = jest.spyOn(stream, 'finish');
  const collect: RuntimeApplication['collectWorkGarbage'] = (_request, _signal, _progress, onFatal) => {
    onFatal!();
    return Promise.reject(new Error('injected terminal port'));
  };
  const handler = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication)['runtime.gcWork'];
  handler({ body: { mode: 'dry_run' }, request: { raw }, reply: { raw: reply, createStream: () => stream } } as unknown as Parameters<typeof handler>[0]);
  await new Promise(resolve => setImmediate(resolve));
  expect(destroy).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  expect(raw.listenerCount('aborted')).toBe(1); expect(reply.listenerCount('close')).toBe(1);
  reply.emit('close');
  expect(destroy).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
});

it('keeps pre-stream failures safe JSON 500 but post-header failures incomplete without a fabricated terminal', async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-stream-failure-'));
  app = Fastify({ logger: false });
  const completion = deferred<WorkGcResponse>();
  const collect = jest.fn<RuntimeApplication['collectWorkGarbage']>(() => { throw new Error('private-path-and-error'); });
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'gc-test' }),
    eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort })
    .mount(app, workGcOperatorApiContracts,
      buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication));
  const headers = { authorization: 'Bearer gc-test', 'content-type': 'application/json' };
  const before = await app.inject({ method: 'POST', url: '/api/runtime/gc-work', headers, payload: { mode: 'dry_run' } });
  expect(before.statusCode).toBe(500); expect(before.headers['content-type']).toContain('application/json');
  expect(before.body).not.toContain('private-path-and-error');
  collect.mockImplementation(() => completion.promise);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${origin}/api/runtime/gc-work`, { method: 'POST', headers,
    body: '{"mode":"dry_run"}', signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(200);
  const body = response.text();
  const rejected = expect(body).rejects.toThrow();
  completion.reject(new Error('private-post-header-failure'));
  await rejected;
});
