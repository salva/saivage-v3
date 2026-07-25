import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import { initProjectTree, testConfigAuthority, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { ProcessLogRefsSchema } from '../../src/contracts/operator-api-processes.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { processesOperatorApiContracts } from '../../src/contracts/operator-api-processes.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { createEventLog } from '../../src/observability/index.js';
import { buildProcessOperatorContractHandlers } from '../../src/server/routes/operator-process-handlers.js';

const providerRoutingReadModelProvider = () => ({ availabilityScope: 'process_local_reset_on_restart' as const, providers: {} });
function runtimeApplication(processRunner: ProcessRunner): RuntimeApplication {
  return {
    processRunner,
    analystRuntime: { submit: async () => { throw new Error('Analyst runtime is not used by process route tests.'); } },
  } as unknown as RuntimeApplication;
}

describe('contract-backed process routes', () => {
  it('keeps the work root invalid as a concrete process-log reference', () => {
    expect(ProcessLogRefsSchema.safeParse({ stdout: 'work:///', stderr: null }).success).toBe(false);
  });

  it('lists safe process views and does not mount process detail', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    initProjectTree(projectRoot);
    const fastify = Fastify({ logger: false });
    try {
      const processes = createTestProcessRunner(projectRoot);
      const processRunner = processes.processRunner;
      const processScope = processRunner.createDirectScope(processes.runtimeProcessRootScope, 'route-test', 'runtime_card');
      const record = processRunner.spawn({ command: 'echo hello', directScope: processScope, category: 'runtime_card', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ownerId: 'runtime-owner', ownerKind: 'runtime' });
      await processRunner.waitForSettlement(record.id);
      registerOperatorContractRoutes({ fastify, projectRoot, configAuthority: testConfigAuthority(projectRoot), runtimeApplication: runtimeApplication(processRunner), saivageConfig: TEST_SAIVAGE_CONFIG, workflows: TEST_RUNTIME_WORKFLOWS, providerRoutingReadModelProvider, authPolicy: new AuthPolicy(), eventLogger: createEventLog(projectRoot), fatalPort: testApplicationFatalPort });

      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        processes: [expect.objectContaining({
          id: record.id,
          card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          owner_id: 'runtime-owner',
          owner_kind: 'runtime',
          status: 'exited',
          ended_at: expect.any(String),
          exit_code: 0,
          logs: {
            stdout: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${record.id}/stdout.log`,
            stderr: `work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/${record.id}/stderr.log`,
          },
        })],
      });

      expect((await fastify.inject({ method: 'GET', url: `/api/processes/${record.id}` })).statusCode).toBe(404);
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('lets list and projection failures reach the strict contract boundary', async () => {
    const marker = 'hostile-process-read-token';
    const failure = Object.assign(new Error(marker), { token: marker, path: `/secret/${marker}` });
    const processRunner = {
      list: () => { throw failure; },
    } as unknown as ProcessRunner;
    const handlers = buildProcessOperatorContractHandlers({ projectRoot: '/secret/project', processRunner });
    const fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: createEventLog('.'), fatalPort: testApplicationFatalPort }).mount(
      fastify,
      processesOperatorApiContracts,
      handlers,
    );
    try {
      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(500);
      expect(list.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(list.body).not.toContain(marker);
    } finally {
      await fastify.close();
    }
  });
});
