import { CardStore } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import type { RuntimeApi } from '../../src/runtime/runtime-api.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { registerOperatorContractRoutes } from '../../src/server/routes/operator-contracts.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';

function createRuntimeApplication(projectRoot: string, calls: { pause: number; resume: number }): RuntimeApplication {
  let status: ReturnType<RuntimeApi['getStatus']>['status'] = 'running';
  const runtimeApi: RuntimeApi = {
    async start() {},
    async shutdown() {},
    pause() {
      calls.pause += 1;
      status = 'paused';
    },
    resume() {
      calls.resume += 1;
      status = 'running';
    },
    notifyCard: () => ({ ok: true }),
    async startProject() {
      throw new Error('startProject is not used by this test.');
    },
    subscribe: () => ({ id: 'test-subscription', pause() {}, resume() {}, unsubscribe() {} }),
    getStatus: () => ({ status, currentCardId: null, goalCount: 0, lastTickAt: null }),
    getActorRuntimeReadModel: () => ({ pauseMode: status === 'paused' ? 'paused' : 'running', activeWork: 'none', cards: [], agents: [], diagnostics: [], recovery: null }),
  };
  const cardStore = new CardStore(projectRoot);
  return {
    runtimeApi,
    cardStore,
    processRunner: createTestProcessRunner(projectRoot),
    analystDeps: undefined as never,
    analystRuntime: undefined as never,
    getProviderRoutingReadModel: () => ({ providers: {} }),
    setMcpManager() {},
  };
}

describe('contract-backed runtime control routes', () => {
  it('pauses and resumes the live runtime through operator contracts', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-route-'));
    const fastify = Fastify({ logger: false });
    const calls = { pause: 0, resume: 0 };
    try {
      registerOperatorContractRoutes({ fastify, projectRoot, runtimeApplication: createRuntimeApplication(projectRoot, calls), cardStore: new CardStore(projectRoot), authPolicy: new AuthPolicy() });

      const pause = await fastify.inject({ method: 'POST', url: '/api/runtime/pause' });
      expect(pause.statusCode).toBe(200);
      expect(calls.pause).toBe(1);
      expect(pause.json()).toEqual(expect.objectContaining({ runtime: 'paused', currentCardId: null, goalCount: 0 }));

      const resume = await fastify.inject({ method: 'POST', url: '/api/runtime/resume' });
      expect(resume.statusCode).toBe(200);
      expect(calls.resume).toBe(1);
      expect(resume.json()).toEqual(expect.objectContaining({ runtime: 'running', currentCardId: null, goalCount: 0 }));
    } finally {
      await fastify.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
