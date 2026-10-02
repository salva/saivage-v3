import { expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { cleanupTestProcessRunners, createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { createAppTerminalCoordinator } from '../../../src/boot/app.js';

it('repeated public Run/Stop and application teardown retire contained processes without sweeping other roots', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-public-process-retirement-'));
  initProjectTree(projectRoot);
  const processes = createTestProcessRunner(projectRoot);
  const runner = processes.processRunner;
  let entered!: () => void;
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction, runtimeGate: new RuntimeGate(), projectRoot,
    actorStore: new CardService(projectRoot), conversations: { projectRoot },
    provider: scriptedAdmissionProvider(async (_input, signal) => {
      entered();
      return new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }),
    freshness: NO_FRESHNESS_EFFECTS,
    processRunner: runner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-02T00:00:00.000Z' },
    promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
  });
  const unrelated = runner.spawn({
    command: 'sleep 60', directScope: runner.createDirectScope(processes.analystProcessRootScope, 'unrelated', 'operator_session'),
    category: 'operator_session', ownerId: 'analyst', ownerKind: 'operator',
  });
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      expect((await supervisor.startProject()).started).toBe(true);
      await entry;
      const record = runner.spawn({
        command: 'sleep 60', directScope: runner.createDirectScope(processes.runtimeProcessRootScope, `cycle-${cycle}`, 'runtime_card'),
        category: 'runtime_card', cardId: 'project', ownerId: 'runtime', ownerKind: 'runtime',
      });
      const held = runner.waitForSettlement(record.id);
      if (cycle < 2) {
        await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
      } else {
        const terminal = createAppTerminalCoordinator();
        terminal.registerAdmissionCloser('runtime', () => supervisor.closeApplicationAdmission());
        terminal.registerCleanupLeaf('runtime', () => supervisor.cleanupForApplicationStop());
        await expect(terminal.stop()).resolves.toEqual({ warnings: [] });
      }
      await expect(held).resolves.toMatchObject({ status: 'killed', record: { id: record.id } });
      expect(supervisor.getStatus().status).toBe('stopped');
      expect(runner.get(record.id)).toBeNull();
      expect(runner.list().map(({ id }) => id)).toEqual([unrelated.id]);
      expect(runner.get(unrelated.id)?.status).toBe('running');
    }
  } finally {
    await supervisor.cleanupForApplicationStop();
    await cleanupTestProcessRunners(projectRoot);
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, 20000);
