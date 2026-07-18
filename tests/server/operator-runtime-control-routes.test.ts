import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Mock } from 'jest-mock';

import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildRuntimeCardOperatorContractHandlers } from '../../src/server/routes/operator-runtime-card-handlers.js';

describe('runtime-control route request contracts', () => {
  let fastify: FastifyInstance;
  const pause = jest.fn();
  const resume = jest.fn();
  const stopProject = jest.fn(async () => ({ status: 'stopped' as const, contained: true }));
  const schedule = jest.fn();
  const acknowledge = jest.fn(async () => {});
  const observedHeaders: Array<Record<string, string | string[] | undefined>> = [];

  beforeEach(async () => {
    pause.mockClear();
    resume.mockClear();
    stopProject.mockClear();
    schedule.mockClear();
    acknowledge.mockClear();
    observedHeaders.length = 0;
    fastify = Fastify({ logger: false });
    fastify.addHook('onRequest', (request, _reply, done) => {
      observedHeaders.push(request.headers);
      done();
    });
    const runtimeApplication = {
      runtimeControl: {
        pause,
        resume,
        stopProject,
        startProject: jest.fn(),
        cancelCard: jest.fn(),
        getStatus: jest.fn(() => ({ status: 'running', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' })),
      },
      runtimeApi: {
        getStatus: jest.fn(() => ({ status: 'running', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' })),
        getActorRuntimeReadModel: jest.fn(() => ({ pauseMode: 'running', cards: [] })),
      },
    } as unknown as RuntimeApplication;
    const handlers = buildRuntimeCardOperatorContractHandlers({
      projectRoot: '/project',
      runtimeApplication,
      restartServerAvailable: true,
      restartPort: { schedule, acknowledge },
    });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'route-token' }) }).mount(fastify, operatorApiContracts, handlers);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  const routes: Array<[string, Mock]> = [
    ['/api/runtime/pause', pause],
    ['/api/runtime/resume', resume],
    ['/api/runtime/stop-project', stopProject as Mock],
  ];
  const suppliedBodies: Array<{ label: string; payload: string }> = [
    { label: 'empty object', payload: '{}' },
    { label: 'id', payload: '{"id":"card"}' },
    { label: 'request ID', payload: '{"requestId":"request"}' },
    { label: 'reason', payload: '{"reason":"because"}' },
    { label: 'null', payload: 'null' },
    { label: 'arbitrary array', payload: '["payload"]' },
  ];

  it.each(routes)('accepts an absent body for %s', async (url, control) => {
    const response = await fastify.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer route-token', accept: 'application/json', 'x-runtime-test': 'ordinary' },
    });

    expect(response.statusCode).toBe(200);
    expect(control).toHaveBeenCalledWith();
    expect(observedHeaders.at(-1)).toMatchObject({ authorization: 'Bearer route-token', accept: 'application/json', 'x-runtime-test': 'ordinary' });
    expect(observedHeaders.at(-1)).not.toHaveProperty('content-type');
  });

  it.each(routes.flatMap(([url, control]) => suppliedBodies.map(({ label, payload }) => [url, label, payload, control] as const)))(
    'rejects a supplied body for %s: %s',
    async (url, _label, payload, control) => {
      const response = await fastify.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer route-token', 'content-type': 'application/json' },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'ValidationError' });
      expect(control).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty request advertised as JSON before Stop mutation', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/runtime/stop-project',
      headers: { authorization: 'Bearer route-token', 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(stopProject).not.toHaveBeenCalled();
  });

  it('retains strict Restart body validation and JSON transport', async () => {
    for (const request of [
      { headers: { authorization: 'Bearer route-token' } },
      { headers: { authorization: 'Bearer route-token', 'content-type': 'application/json' }, payload: '{"confirmation":"wrong"}' },
      { headers: { authorization: 'Bearer route-token', 'content-type': 'application/json' }, payload: '{"confirmation":"RESTART SERVER","extra":true}' },
    ]) {
      const response = await fastify.inject({ method: 'POST', url: '/api/runtime/restart-server', ...request });
      expect(response.statusCode).toBe(400);
    }
    expect(schedule).not.toHaveBeenCalled();

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/runtime/restart-server',
      headers: { authorization: 'Bearer route-token', accept: 'application/json', 'content-type': 'application/json' },
      payload: '{"confirmation":"RESTART SERVER"}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'restart_scheduled' });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(observedHeaders.at(-1)).toMatchObject({ authorization: 'Bearer route-token', accept: 'application/json', 'content-type': 'application/json' });
  });
});
