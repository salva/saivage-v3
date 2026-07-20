import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';

import { eventsOperatorApiContracts } from '../../src/contracts/operator-api-events.js';
import { EventBus } from '../../src/events/index.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildEventsOperatorContractHandlers } from '../../src/server/routes/operator-events-handlers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator Events handler boundary', () => {
  it('preserves successful empty projection and delegates malformed persistence to ContractRuntime', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-events-route-'));
    roots.push(projectRoot);
    const fastify = Fastify({ logger: false });
    const handlers = buildEventsOperatorContractHandlers({ projectRoot });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus: new EventBus() }).mount(
      fastify,
      eventsOperatorApiContracts,
      handlers,
    );
    try {
      const empty = await fastify.inject({ method: 'GET', url: '/api/events' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ events: [], total: 0 });

      const marker = 'hostile-events-persistence-token';
      mkdirSync(dirname(appLogFile(projectRoot)), { recursive: true });
      writeFileSync(appLogFile(projectRoot), `{"marker":"${marker}"}\n`);

      expect(() => handlers['events.list']!({ query: {} } as never)).toThrow();
      const malformed = await fastify.inject({ method: 'GET', url: '/api/events' });
      expect(malformed.statusCode).toBe(500);
      expect(malformed.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(malformed.body).not.toContain(marker);
    } finally {
      await fastify.close();
    }
  });
});
