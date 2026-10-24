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

let app: FastifyInstance | undefined;
let root: string | undefined;
afterEach(async () => { await app?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
const refusal: WorkGcResponse = { mode: 'dry_run', disposition: 'refused',
  reason: 'maintenance_refused', restoration: 'not_acquired', result: null };
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
  expect(WorkGcResponseSchema.parse(response.json())).toEqual(refusal);
  collect.mockRejectedValue(new WorkGcBusyError());
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
    return { ...refusal, reason: 'cancelled' };
  });
  const handler = buildWorkGcOperatorContractHandlers({ collectWorkGarbage: collect } as unknown as RuntimeApplication)['runtime.gcWork'];
  const task = handler({ body: { mode: 'dry_run' }, request: { raw }, reply: { raw: reply } } as unknown as Parameters<typeof handler>[0]);
  await entry;
  reply.emit('close');
  expect(await task).toMatchObject({ body: { reason: 'cancelled' } });
  expect(collect.mock.calls[0]![1].aborted).toBe(true);
});
