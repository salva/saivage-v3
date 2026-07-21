import { describe, expect, it, jest } from '@jest/globals';
import Fastify from 'fastify';

import { operatorApiContracts, type OperatorApiOperationId, type OperatorRouteContract } from '../../src/contracts/operator-api.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime, type ContractHandler } from '../../src/server/contract-runtime.js';
import { createEventLog } from '../../src/observability/index.js';

const unauthorized = { error: 'Unauthorized', statusCode: 401 };

const process = {
  id: 'process-1',
  status: 'running',
  started_at: '2026-07-20T00:00:00.000Z',
  ended_at: null,
  exit_code: null,
  timed_out: false,
  owner_id: 'runtime',
  owner_kind: 'runtime',
  session_id: null,
  card_id: null,
  command: 'true',
  cwd: null,
  logs: { stdout: null, stderr: null },
} as const;

const affectedCases = [
  { operationId: 'events.list', url: '/api/events', body: { events: [], total: 0 } },
  { operationId: 'processes.list', url: '/api/processes', body: { processes: [] } },
  { operationId: 'processes.get', url: '/api/processes/process-1', body: { process } },
  { operationId: 'config.get', url: '/api/config', body: { config: {}, warnings: [] } },
  { operationId: 'providers.list', url: '/api/providers', body: { availabilityScope: 'process_local_reset_on_restart', providers: {} } },
  { operationId: 'controlActions.list', url: '/api/control-actions', body: { control_actions: [], total: 0 } },
] as const satisfies ReadonlyArray<{ operationId: OperatorApiOperationId; url: string; body: unknown }>;

function mountCases(authPolicy: AuthPolicy) {
  const fastify = Fastify({ logger: false });
  const contracts: Record<string, OperatorRouteContract> = {};
  const handlers: Record<string, ContractHandler> = {};

  for (const testCase of affectedCases) {
    contracts[testCase.operationId] = operatorApiContracts[testCase.operationId];
    handlers[testCase.operationId] = jest.fn(() => ({ body: testCase.body }));
  }
  contracts['health.liveness'] = operatorApiContracts['health.liveness'];
  contracts['health.readiness'] = operatorApiContracts['health.readiness'];
  handlers['health.liveness'] = jest.fn(() => ({ body: { status: 'ok', version: 'test', project: 'test' } }));
  handlers['health.readiness'] = jest.fn(() => ({ body: { status: 'ready' } }));

  new ContractRuntime({ authPolicy, eventLogger: createEventLog('.') }).mount(fastify, contracts, handlers);
  return { fastify, handlers };
}

describe('affected operator route authentication', () => {
  it('rejects missing and invalid bearer credentials before handlers and admits exact bearer credentials', async () => {
    const { fastify, handlers } = mountCases(new AuthPolicy({ apiToken: 'route-token' }));
    try {
      for (const testCase of affectedCases) {
        const handler = handlers[testCase.operationId] as jest.Mock;

        const missing = await fastify.inject({ method: 'GET', url: testCase.url });
        expect(missing.statusCode).toBe(401);
        expect(missing.json()).toEqual(unauthorized);
        expect(handler).not.toHaveBeenCalled();

        const invalid = await fastify.inject({ method: 'GET', url: testCase.url, headers: { authorization: 'Bearer wrong-token' } });
        expect(invalid.statusCode).toBe(401);
        expect(invalid.json()).toEqual(unauthorized);
        expect(handler).not.toHaveBeenCalled();

        const admitted = await fastify.inject({ method: 'GET', url: testCase.url, headers: { authorization: 'Bearer route-token' } });
        expect(admitted.statusCode).toBe(200);
        expect(admitted.json()).toEqual(testCase.body);
        expect(handler).toHaveBeenCalledTimes(1);
      }
    } finally {
      await fastify.close();
    }
  });

  it('keeps both health probes public under an auth-enabled policy', async () => {
    const { fastify, handlers } = mountCases(new AuthPolicy({ apiToken: 'route-token' }));
    try {
      const liveness = await fastify.inject({ method: 'GET', url: '/health' });
      const readiness = await fastify.inject({ method: 'GET', url: '/health/ready' });

      expect(liveness.statusCode).toBe(200);
      expect(liveness.json()).toEqual({ status: 'ok', version: 'test', project: 'test' });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json()).toEqual({ status: 'ready' });
      expect(handlers['health.liveness']).toHaveBeenCalledTimes(1);
      expect(handlers['health.readiness']).toHaveBeenCalledTimes(1);
    } finally {
      await fastify.close();
    }
  });

  it('admits every affected route without a header when authentication is disabled', async () => {
    const { fastify, handlers } = mountCases(new AuthPolicy());
    try {
      for (const testCase of affectedCases) {
        const response = await fastify.inject({ method: 'GET', url: testCase.url });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(testCase.body);
        expect(handlers[testCase.operationId]).toHaveBeenCalledTimes(1);
      }
    } finally {
      await fastify.close();
    }
  });

  it('rejects authentication before validating an affected request', async () => {
    const { fastify, handlers } = mountCases(new AuthPolicy({ apiToken: 'route-token' }));
    try {
      const response = await fastify.inject({ method: 'GET', url: '/api/events?limit=-1' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unauthorized);
      expect(handlers['events.list']).not.toHaveBeenCalled();
    } finally {
      await fastify.close();
    }
  });
});
