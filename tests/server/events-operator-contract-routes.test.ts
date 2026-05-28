import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operatorRouteInventory } from '../../src/contracts/operator-api.js';
import { EventLogger } from '../../src/observability/index.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';

const timestamp = '2026-01-01T00:00:00.000Z';

describe('contract-backed events route', () => {
  it('lists logged events through the operator contract runtime', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-events-route-'));
    const fastify = Fastify({ logger: false });
    try {
      const logger = new EventLogger(join(projectRoot, '.saivage'));
      logger.appendEvent({ kind: 'started', id: 'evt-started', timestamp, project_root: projectRoot });
      logger.appendEvent({ kind: 'session_started', id: 'evt-session', timestamp, session_id: 'planner:goal-1', role: 'planner', goal_id: 'goal-1', card_id: 'goal-1' });
      logger.close();
      registerOperatorContractRoutes({ fastify, projectRoot });

      const response = await fastify.inject({ method: 'GET', url: '/api/events?kind=session_started&limit=1&offset=0' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        events: [expect.objectContaining({ id: 'evt-session', kind: 'session_started', session_id: 'planner:goal-1' })],
        total: 1,
      });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('declares events.list as the only contract inventory owner for GET /api/events', () => {
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'events.list', method: 'GET', path: '/api/events', successSchemaName: 'EventsListResponse' }),
    ]));
    expect(operatorRouteInventory().filter((route) => route.path === '/api/events')).toHaveLength(1);
  });
});
