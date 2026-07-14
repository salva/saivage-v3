import { initProjectTree, CardStore } from '../../helpers/canonical-project.js';
import { describe, expect, it, jest } from '@jest/globals';
import { testConversationMutations } from '../../helpers/conversation-mutations.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { createSupervisorRuntimeApi, type SupervisorRuntimeApiOptions } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeControlService } from '../../../src/application/runtime-control-service.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { readRuntimeState } from '../../../src/runtime/state-api.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { updateRuntimeState } from '../../helpers/runtime-state.js';
import { testRuntimePersistence } from '../../helpers/runtime-persistence.js';

function descendantAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function createControlledRuntime(options: SupervisorRuntimeApiOptions) {
  const mechanics = createSupervisorRuntimeApi(options);
  return new RuntimeControlService({ projectRoot: options.projectRoot, persistenceHealth: options.persistenceHealth, interventionBinding: options.interventionBinding, runtimeState: options.runtimeState, appLogs: options.appLogs, eventBus: options.eventBus, mechanics });
}

describe('SupervisorRuntimeApi shutdown', () => {
  it('publishes serving pause/resume writes but excludes startup and shutdown writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-supervisor-freshness-'));
    const runner = createTestProcessRunner(root);
    try {
      initProjectTree(root);
      const changes = new ReadModelChangeBroadcaster();
      const runtimeChanged = jest.fn();
      changes.subscribe({ runtimeChanged, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {} });
    const runtime = createControlledRuntime({ ...testRuntimePersistence(root, changes),
        projectRoot: root,
        conversations: testConversationMutations(root),
        appLogs: testAppLogs(root),
        readModelChanges: changes,
        actorStore: new CardStore(root).repository,
        provider: { completeTurn: async () => { throw new Error('provider must not be called'); } },
        processRunner: runner,
        promptTemplates: createTestPromptTemplateRegistry(),
      });

      await runtime.start();
      expect(runtimeChanged).not.toHaveBeenCalled();
      updateRuntimeState(root, { status: 'running' });
      runtime.pause();
      runtime.resume();
      expect(runtimeChanged).toHaveBeenCalledTimes(2);

      await runtime.shutdown();
      expect(runtimeChanged).toHaveBeenCalledTimes(2);
      expect(readRuntimeState(root)?.status).toBe('stopped');
    } finally {
      await runner.terminateScopeTree({ rootScope: runner.runtimeRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is terminal, cancels runtime-owned groups, and shares repeated shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-supervisor-shutdown-'));
    const runner = createTestProcessRunner(root);
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      const changes = new ReadModelChangeBroadcaster();
      const runtime = createControlledRuntime({ ...testRuntimePersistence(root, changes),
        projectRoot: root,
        conversations: testConversationMutations(root),
        appLogs: testAppLogs(root),
        readModelChanges: changes,
        actorStore: store.repository,
        provider: { completeTurn: async () => { throw new Error('provider must not be called'); } },
        processRunner: runner,
        promptTemplates: createTestPromptTemplateRegistry(),
      });
      await runtime.start();

      const pidFile = join(root, 'descendant.pid');
      const processScope = runner.createDirectScope(runner.runtimeRootScope, 'test-runtime', 'runtime_card');
      const record = runner.spawn({ command: `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; exit`, directScope: processScope, category: 'runtime_card', cardId: 'project', ownerId: 'planner:project', ownerKind: 'agent' });
      for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const descendantPid = Number(readFileSync(pidFile, 'utf8').trim());

      const first = runtime.shutdown();
      const second = runtime.shutdown();
      expect(second).toBe(first);
      await first;

      for (let attempt = 0; attempt < 100 && descendantAlive(descendantPid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(descendantAlive(descendantPid)).toBe(false);
      expect(runner.get(record.id)).toMatchObject({ status: 'killed' });
      expect(readRuntimeState(root)).toMatchObject({ status: 'stopped', active_card_run: null });
      await expect(runtime.start()).rejects.toThrow('Cannot start a shutdown runtime.');
      await expect(runtime.startProject()).resolves.toMatchObject({ started: false, error: 'Cannot start runtime: runtime is shutting down.' });
      expect(() => runtime.pause()).toThrow('Cannot pause a shutdown runtime.');
      expect(() => runtime.resume()).toThrow('Cannot resume a shutdown runtime.');
      expect(() => runtime.notifyCard('project', { id: 'late', message: 'late', created_at: new Date().toISOString() })).toThrow('Cannot notify a shutdown runtime.');
    } finally {
      await runner.terminateScopeTree({ rootScope: runner.runtimeRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wins the start-project admission race before root work can be created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-supervisor-race-'));
    const runner = createTestProcessRunner(root);
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      const changes = new ReadModelChangeBroadcaster();
      const runtime = createControlledRuntime({ ...testRuntimePersistence(root, changes),
        projectRoot: root,
        conversations: testConversationMutations(root),
        appLogs: testAppLogs(root),
        readModelChanges: changes,
        actorStore: store.repository,
        provider: { completeTurn: async () => { throw new Error('provider must not be called'); } },
        processRunner: runner,
        promptTemplates: createTestPromptTemplateRegistry(),
      });

      const starting = runtime.startProject();
      await runtime.shutdown();

      await expect(starting).resolves.toMatchObject({ started: false, error: 'Cannot start runtime: runtime is shutting down.' });
      expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null, goalCount: 0 });
      expect(runner.list({ status: 'running' })).toEqual([]);
    } finally {
      await runner.terminateScopeTree({ rootScope: runner.runtimeRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
