import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import {
  CardService,
  initProjectTree,
  testConfigAuthority,
  TEST_RUNTIME_WORKFLOWS,
} from '../helpers/canonical-project.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import {
  ProcessLogRefsSchema,
  ProcessViewSchema,
} from '../../src/contracts/operator-api-processes.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { processesOperatorApiContracts } from '../../src/contracts/operator-api-processes.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { createEventLog } from '../../src/observability/index.js';
import { buildProcessOperatorContractHandlers } from '../../src/server/routes/operator-process-handlers.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';
import { writeSaivageConfig } from '../helpers/project-config.js';

const providerRoutingReadModelProvider = () => ({
  availabilityScope: 'process_local_reset_on_restart' as const,
  providers: {},
});
function runtimeApplication(
  processRunner: ProcessRunner,
  cardStore: CardService,
): RuntimeApplication {
  return {
    processRunner,
    cardStore,
    analystRuntime: {
      submit: async () => {
        throw new Error('Analyst runtime is not used by process route tests.');
      },
    },
  } as unknown as RuntimeApplication;
}

describe('contract-backed process routes', () => {
  const processView = {
    id: 'proc-1',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    exit_code: null,
    timed_out: false,
    owner_id: 'runtime',
    owner_kind: 'runtime' as const,
    session_id: null,
    card_id: null,
    command: 'echo ok',
    cwd: null,
    logs: { stdout: null, stderr: null },
  };

  it.each(['running', 'exited', 'failed', 'killed'] as const)(
    'accepts process status %s',
    (status) => {
      expect(ProcessViewSchema.parse({ ...processView, status }).status).toBe(status);
    },
  );

  it('rejects unknown process status and extra members', () => {
    expect(ProcessViewSchema.safeParse({ ...processView, status: 'unknown' }).success).toBe(false);
    expect(
      ProcessViewSchema.safeParse({ ...processView, status: 'running', unexpected: true }).success,
    ).toBe(false);
  });

  it('keeps the work root invalid as a concrete process-log reference', () => {
    expect(ProcessLogRefsSchema.safeParse({ stdout: 'work:///', stderr: null }).success).toBe(
      false,
    );
  });

  it('lists only current process presentations, keeps retired log URLs readable, and does not mount process detail', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-route-'));
    initProjectTree(projectRoot);
    writeSaivageConfig(projectRoot, TEST_SAIVAGE_CONFIG);
    const fastify = Fastify({ logger: false });
    try {
      const processes = createTestProcessRunner(projectRoot);
      const processRunner = processes.processRunner;
      const cardStore = new CardService(projectRoot);
      const mcpManager = new McpManager({
        configAuthority: testConfigAuthority(projectRoot),
        processRunner,
        mcpProcessRootScope: processes.mcpProcessRootScope,
        eventLogger: createEventLog(projectRoot),
      });
      const processScope = processRunner.createDirectScope(
        processes.runtimeProcessRootScope,
        'route-test',
        'runtime_card',
      );
      const record = processRunner.spawn({
        command: 'echo hello',
        directScope: processScope,
        category: 'runtime_card',
        cardId: null,
        ownerId: 'runtime-owner',
        ownerKind: 'runtime',
      });
      await processRunner.waitForSettlement(record.id);
      registerOperatorContractRoutes({
        fastify,
        projectRoot,
        cardStore,
        mcpManager,
        serverAvailabilityProvider: () => ({
          generatedAt: '2026-01-01T00:00:00.000Z',
          components: {
            api: {
              state: 'available',
              source: 'health-check',
              checkedAt: '2026-01-01T00:00:00.000Z',
            },
            runtime: {
              state: 'available',
              source: 'runtime-application',
              checkedAt: '2026-01-01T00:00:00.000Z',
            },
            mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2026-01-01T00:00:00.000Z' },
          },
        }),
        configAuthority: testConfigAuthority(projectRoot),
        runtimeApplication: runtimeApplication(processRunner, cardStore),
        saivageConfig: TEST_SAIVAGE_CONFIG,
        workflows: TEST_RUNTIME_WORKFLOWS,
        providerRoutingReadModelProvider,
        authPolicy: new AuthPolicy(),
        restartCapability: { available: false },
        eventLogger: createEventLog(projectRoot),
        fatalPort: testApplicationFatalPort,
      });

      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        processes: [
          expect.objectContaining({
            id: record.id,
            card_id: null,
            owner_id: 'runtime-owner',
            owner_kind: 'runtime',
            status: 'exited',
            ended_at: expect.any(String),
            exit_code: 0,
            logs: {
              stdout: `work:///processes/${record.id}/stdout.log`,
              stderr: `work:///processes/${record.id}/stderr.log`,
            },
          }),
        ],
      });
      const view = list.json().processes[0];
      expect(ProcessViewSchema.safeParse({ ...view, unexpected: true }).success).toBe(false);
      expect(
        ProcessViewSchema.safeParse({ ...view, logs: { ...view.logs, unexpected: true } }).success,
      ).toBe(false);

      expect(
        (await fastify.inject({ method: 'GET', url: `/api/processes/${record.id}` })).statusCode,
      ).toBe(404);

      processRunner.retireSettled(record.id, processScope);
      expect((await fastify.inject({ method: 'GET', url: '/api/processes' })).json()).toEqual({ processes: [] });
      const retainedLog = new WorkspaceFileReadModelService(projectRoot, () => cardStore, testConfigAuthority(projectRoot))
        .readFileContent(`work:///processes/${record.id}/stdout.log`);
      expect(retainedLog).toEqual(expect.objectContaining({ body: expect.objectContaining({ content: 'hello\n' }) }));
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('lets list and projection failures reach the strict contract boundary', async () => {
    const marker = 'hostile-process-read-token';
    const failure = Object.assign(new Error(marker), { token: marker, path: `/secret/${marker}` });
    const processRunner = {
      list: () => {
        throw failure;
      },
    } as unknown as ProcessRunner;
    const handlers = buildProcessOperatorContractHandlers({
      projectRoot: '/secret/project',
      processRunner,
    });
    const fastify = Fastify({ logger: false });
    new ContractRuntime({
      authPolicy: new AuthPolicy(),
      eventLogger: createEventLog('.'),
      fatalPort: testApplicationFatalPort,
    }).mount(fastify, processesOperatorApiContracts, handlers);
    try {
      const list = await fastify.inject({ method: 'GET', url: '/api/processes' });
      expect(list.statusCode).toBe(500);
      expect(list.json()).toEqual({
        error: 'InternalServerError',
        message: 'Internal server error',
      });
      expect(list.body).not.toContain(marker);
    } finally {
      await fastify.close();
    }
  });
});
