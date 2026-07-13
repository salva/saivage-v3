import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';

describe('contract-backed process routes', () => {
  it('lists and reads safe process views without the old hand-mounted route owner', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    const fastify = Fastify({ logger: false });
    try {
      const processRunner = createTestProcessRunner(projectRoot);
      const processScope = processRunner.createDirectScope(processRunner.runtimeRootScope, 'route-test', 'runtime_card');
      const record = processRunner.spawn({ command: 'echo hello', directScope: processScope, category: 'runtime_card', cardId: 'card-1', ownerId: 'runtime-owner', ownerKind: 'runtime' });
      await processRunner.waitForSettlement(record.id);
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), runtimeApplication: { processRunner } as RuntimeApplication, authPolicy: new AuthPolicy() });

      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        processes: [expect.objectContaining({
          id: record.id,
          card_id: 'card-1',
          owner_id: 'runtime-owner',
          owner_kind: 'runtime',
          status: 'exited',
          ended_at: expect.any(String),
          exit_code: 0,
          logs: {
            stdout: `work:///cards/card-1/processes/${record.id}/stdout.log`,
            stderr: `work:///cards/card-1/processes/${record.id}/stderr.log`,
          },
        })],
      });

      const detail = await fastify.inject({ method: 'GET', url: `/api/processes/${record.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().process.id).toBe(record.id);
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves the existing missing-process 404 body', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    const fastify = Fastify({ logger: false });
    try {
      const processRunner = createTestProcessRunner(projectRoot);
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), runtimeApplication: { processRunner } as RuntimeApplication, authPolicy: new AuthPolicy() });

      const response = await fastify.inject({ method: 'GET', url: '/api/processes/missing' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Process not found', processId: 'missing' });
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
