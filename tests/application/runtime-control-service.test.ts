import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeControlService, type RuntimeControlMechanics } from '../../src/application/runtime-control-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { initProjectTree, testPersistenceHealth } from '../helpers/canonical-project.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import type { RuntimeState } from '../../src/schemas/index.js';
import { RuntimeStateStore } from '../../src/runtime/state.js';
import { AppLogStore } from '../../src/persistence/app-log.js';

function mechanics(state: RuntimeState): RuntimeControlMechanics {
  let status = state.status;
  return {
    async start() {},
    async shutdown() {},
    beginStartProject: jest.fn(async () => ({ accepted: true as const, state: { ...state, status: 'running' as const } })),
    launchStartedProject: jest.fn(() => { status = 'running'; }),
    beginPause: jest.fn(() => { status = 'paused'; return { patch: { status: 'paused' as const, active_card_run: null, updated_at: state.updated_at }, settled: true }; }),
    beginResume: jest.fn((current: RuntimeState) => ({ ...current, status: 'running' as const })),
    finishResume: jest.fn(() => { status = 'running'; }),
    notifyCard: () => ({ ok: true }),
    subscribe: () => ({ id: 'runtime-control-test', pause() {}, resume() {}, unsubscribe() {} }),
    getStatus: () => ({ status, currentCardId: null, goalCount: 0, lastTickAt: null }),
    getActorRuntimeReadModel: () => ({ pauseMode: 'idle', activeWork: 'none', cards: [], agents: [], diagnostics: [], recovery: null }),
  };
}

describe('RuntimeControlService lifecycle ownership', () => {
  it('owns one state mutation and one lifecycle audit for each serving control', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-service-'));
    try {
      initProjectTree(root);
      const health = testPersistenceHealth(root);
      const runtimeState = new RuntimeStateStore(root, health); runtimeState.restabilize();
      const initial = runtimeState.initialize();
      const appLogs = new AppLogStore(root, health); appLogs.restabilize();
      const runtimeMechanics = mechanics(initial);
      const service = new RuntimeControlService({ projectRoot: root, persistenceHealth: health, interventionBinding: new RuntimeInterventionBinding(), runtimeState, appLogs, mechanics: runtimeMechanics });
      const request = { actor: 'user' as const, surface: 'rest' as const, paramsSummary: '{}' };

      await expect(service.startProject('operator', request)).resolves.toMatchObject({ status: 'running', started: true });
      service.pause(request);
      service.resume(request);

      expect(listControlActions(root).map((entry) => entry.action).sort()).toEqual(['runtime.pause', 'runtime.resume', 'runtime.start_project']);
      expect(runtimeMechanics.launchStartedProject).toHaveBeenCalledTimes(1);
      expect(runtimeMechanics.beginPause).toHaveBeenCalledTimes(1);
      expect(runtimeMechanics.beginResume).toHaveBeenCalledTimes(1);
      expect(runtimeState.read()?.status).toBe('running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects before mechanics, state, or audit after persistence becomes unhealthy', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-unhealthy-'));
    try {
      initProjectTree(root);
      const health = testPersistenceHealth(root);
      const runtimeState = new RuntimeStateStore(root, health); runtimeState.restabilize();
      const initial = runtimeState.initialize(); runtimeState.patch({ status: 'running' });
      const appLogs = new AppLogStore(root, health); appLogs.restabilize();
      const runtimeMechanics = mechanics(initial);
      const service = new RuntimeControlService({ projectRoot: root, persistenceHealth: health, interventionBinding: new RuntimeInterventionBinding(), runtimeState, appLogs, mechanics: runtimeMechanics });
      expect(() => health.reportUncertainFailure({ target: '.saivage/logs/app.jsonl', operation: 'append', error: new Error('fsync uncertain') })).toThrow();

      expect(() => service.pause({ actor: 'user', surface: 'rest', paramsSummary: '{}' })).toThrow(/mutation-unhealthy/);
      expect(runtimeMechanics.beginPause).not.toHaveBeenCalled();
      expect(listControlActions(root)).toEqual([]);
      expect(runtimeState.read()?.status).toBe('running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
