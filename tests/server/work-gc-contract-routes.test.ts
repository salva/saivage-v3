import { afterEach, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkGcBusyError, WorkGcResponseSchema, type WorkGcResponse, type WorkGcStatus } from '../../src/contracts/index.js';
import { workGcOperatorApiContracts } from '../../src/contracts/operator-api-work-gc.js';
import { buildWorkGcOperatorContractHandlers } from '../../src/server/routes/operator-work-gc-handlers.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
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
  reason: 'reference_scope_unresolved', restoration: 'not_resumed', failure: { code: 'EACCES', syscall: 'realpath' }, result: null };
const idle = () => ({ active: null });

it.each([true, false])('uses the registered contract and real socket auth (enabled=%s), keeping POST auth unchanged', async authEnabled => {
  root = mkdtempSync(join(tmpdir(), 'gc-status-socket-'));
  const server = app = Fastify({ logger: false });
  const token = 'synthetic-gc-status-test';
  const authPolicy = new AuthPolicy(authEnabled ? { apiToken: token } : {});
  const getWorkGcStatus = jest.fn<RuntimeApplication['getWorkGcStatus']>(idle);
  const collectWorkGarbage = jest.fn<RuntimeApplication['collectWorkGarbage']>().mockResolvedValue(refusal);
  const gcApplication = { getWorkGcStatus, collectWorkGarbage } satisfies Pick<
    RuntimeApplication, 'getWorkGcStatus' | 'collectWorkGarbage'
  >;
  registerOperatorContractRoutes({
    fastify: server, projectRoot: root, authPolicy, eventLogger: createEventLog(root),
    fatalPort: testApplicationFatalPort, restartCapability: { available: false },
    // The other registered operations are not invoked in this fixture.
    runtimeApplication: gcApplication as unknown as RuntimeApplication,
    cardStore: null as never, configAuthority: null as never, workflows: null as never,
    mcpManager: null as never, mcpLifecycleIngress: null as never,
    serverAvailabilityProvider: () => { throw new Error('Unexpected readiness read'); },
    providerRoutingReadModelProvider: () => { throw new Error('Unexpected provider read'); },
  });
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const path = `${origin}/api/runtime/gc-work`;
  const valid = { authorization: `Bearer ${token}` };
  const get = (headers?: HeadersInit, suffix = '') =>
    fetch(`${path}/status${suffix}`, { headers, signal: AbortSignal.timeout(2000) });
  const post = (headers: Record<string, string> = {}) =>
    fetch(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{"mode":"dry_run"}', signal: AbortSignal.timeout(2000) });
  if (authEnabled) {
    for (const denial of [
      () => get(),
      () => get({ authorization: 'NotBearer placeholder' }),
      () => get({ authorization: 'Bearer synthetic-gc-wrong-test' }),
      () => get(valid, '?token=placeholder'),
      () => post(),
    ]) {
      const response = await denial();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized', statusCode: 401 });
      expect(getWorkGcStatus).not.toHaveBeenCalled();
      expect(collectWorkGarbage).not.toHaveBeenCalled();
    }
    const status = await get(valid);
    expect(status.status).toBe(200);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(status.headers.get('content-type')).toContain('application/json');
    expect(await status.json()).toEqual({ active: null });
    expect(getWorkGcStatus).toHaveBeenCalledTimes(1);
  } else {
    for (const headers of [undefined, valid]) {
      const status = await get(headers);
      expect(status.status).toBe(403);
      expect(status.headers.get('cache-control')).toBe('no-store');
      expect(status.headers.get('content-type')).toContain('application/json');
      expect(await status.json()).toEqual({
        error: 'Forbidden', message: 'Work garbage collection status requires operator authentication.',
      });
      expect(getWorkGcStatus).not.toHaveBeenCalled();
    }
  }
  expect(collectWorkGarbage).not.toHaveBeenCalled();
  const admitted = await post(authEnabled ? valid : undefined);
  expect(admitted.status).toBe(200);
  const decoder = new WorkGcStreamDecoder(admitted.headers.get('content-type'));
  decoder.push(new Uint8Array(await admitted.arrayBuffer()));
  expect(decoder.finish()).toEqual(refusal);
  expect(collectWorkGarbage).toHaveBeenCalledTimes(1);
});

it('status handler only calls the getter and contract runtime fails safely on invalid shapes and ordinary throws', async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-status-handler-'));
  app = Fastify({ logger: false });
  const active: WorkGcStatus = { active: { mode: 'delete', phase: 'retention_marking',
    substep: 'record_projection', elapsed_ms: 250, step_elapsed_ms: 10,
    last_checkpoint_elapsed_ms: 245, counters: { inspected_records: 0, reference_visits: 256 },
    first_global_protection: null } };
  const getWorkGcStatus = jest.fn<RuntimeApplication['getWorkGcStatus']>().mockReturnValue(active);
  const collectWorkGarbage = jest.fn<RuntimeApplication['collectWorkGarbage']>();
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'gc-test' }),
    eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort })
    .mount(app, workGcOperatorApiContracts,
      buildWorkGcOperatorContractHandlers({ getWorkGcStatus, collectWorkGarbage }, true));
  const request = { method: 'GET' as const, url: '/api/runtime/gc-work/status', headers: { authorization: 'Bearer gc-test' } };
  const response = await app.inject(request);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(active);
  getWorkGcStatus.mockReturnValueOnce({ ...active, path: 'private-getter-fixture' } as WorkGcStatus)
    .mockImplementationOnce(() => { throw new Error('private-getter-fixture'); });
  for (let i = 0; i < 2; i++) {
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
  }
  expect(getWorkGcStatus).toHaveBeenCalledTimes(3);
  expect(collectWorkGarbage).not.toHaveBeenCalled();
});

it('strict route authenticates, rejects invalid filters and maps duplicate GC to busy without invoking twice', async () => {
  root = mkdtempSync(join(tmpdir(), 'gc-routes-'));
  app = Fastify({ logger: false });
  const collect = jest.fn<RuntimeApplication['collectWorkGarbage']>().mockResolvedValue(refusal);
  const handlers = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect, getWorkGcStatus: idle }, true);
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'gc-test' }),
    eventLogger: createEventLog(root), fatalPort: testApplicationFatalPort })
    .mount(app, workGcOperatorApiContracts, handlers);
  const request = { method: 'POST' as const, url: '/api/runtime/gc-work', payload: { mode: 'dry_run' } };
  expect((await app.inject(request)).statusCode).toBe(401);
  const headers = { authorization: 'Bearer gc-test' };
  expect((await app.inject({ ...request, headers, payload: { mode: 'dry_run', delete: true } })).statusCode).toBe(400);
  expect((await app.inject({ ...request, headers, payload: { mode: 'dry_run', before: '2026-10-24T00:00:00+9900' } })).statusCode).toBe(400);
  for (const min_file_bytes of ['400000000', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect((await app.inject({ ...request, headers, payload: { ...request.payload, min_file_bytes } })).statusCode).toBe(400);
  expect(collect).not.toHaveBeenCalled();
  const response = await app.inject({ ...request, headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('application/x-ndjson');
  const decoder = new WorkGcStreamDecoder(response.headers['content-type'] as string);
  decoder.push(Buffer.from(response.body));
  expect(WorkGcResponseSchema.parse(decoder.finish())).toEqual(refusal);
  expect(collect.mock.calls[0]![0]).toEqual(request.payload);
  for (const min_file_bytes of [0, Number.MAX_SAFE_INTEGER]) {
    const payload = { ...request.payload, min_file_bytes };
    expect((await app.inject({ ...request, headers, payload })).statusCode).toBe(200);
    expect(collect.mock.calls.at(-1)![0]).toEqual(payload);
  }
  collect.mockImplementation(() => { throw new WorkGcBusyError(); });
  const busy = await app.inject({ ...request, headers });
  expect(busy.statusCode).toBe(409);
  expect(busy.json()).toEqual({ error: 'WorkGcBusy', message: 'Work garbage collection is busy.' });
  expect(collect).toHaveBeenCalledTimes(4);
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
  const handler = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect, getWorkGcStatus: idle }, true)['runtime.gcWork'];
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
      buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect, getWorkGcStatus: idle }, true));
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
  const optional = jest.spyOn(stream, 'optional');
  const progress = { phase: 'retention_marking', elapsed_ms: 0,
    first_global_protection: { reason: 'process_owner_uncertain', source: 'process_owner' } } as const;
  const collect: RuntimeApplication['collectWorkGarbage'] = (_request, _signal, observe, onFatal) => {
    observe?.(progress);
    onFatal!();
    return Promise.reject(new Error('injected terminal port'));
  };
  const handler = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect, getWorkGcStatus: idle }, true)['runtime.gcWork'];
  handler({ body: { mode: 'dry_run' }, request: { raw }, reply: { raw: reply, createStream: () => stream } } as unknown as Parameters<typeof handler>[0]);
  await new Promise(resolve => setImmediate(resolve));
  expect(optional).toHaveBeenCalledWith({ type: 'progress', progress });
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
      buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect, getWorkGcStatus: idle }, true));
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
