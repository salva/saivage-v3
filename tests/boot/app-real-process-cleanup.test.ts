import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ProcessStopReport } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('App real managed-process cleanup', () => {
  it('allows production TERM grace, KILL escalation, and absence verification inside the App bound', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-app-process-cleanup-'));
    try {
      const registry = new ManagedProcessGroupRegistry();
      const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
      const runner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
      const scope = runner.createDirectScope(runtimeProcessRootScope, 'resistant-runtime', 'runtime_card');
      const readinessPath = join(projectRoot, 'resistant-runtime.ready');
      const processRecord = runner.spawn({
        command: "trap '' TERM; : > \"$READY_PATH\"; while true; do sleep 1; done",
        directScope: scope,
        category: 'runtime_card',
        cardId: 'project',
        ownerId: 'runtime-test',
        ownerKind: 'runtime',
        env: { READY_PATH: readinessPath },
      });
      const calls: string[] = [];
      let processStopReport: ProcessStopReport | undefined;
      const terminal = createAppTerminalCoordinator();
      terminal.registerCleanupLeaf('fastify', () => { calls.push('following'); });
      terminal.registerCleanupLeaf('runtime', async () => {
        calls.push('runtime');
        processStopReport = await runner.terminateScopeTree({ rootScope: runtimeProcessRootScope, categories: ['runtime_card'], reason: 'application stopping', graceMs: 5_000 });
        if (processStopReport.failed.length !== 0) throw new Error('managed process cleanup failed');
      });

      const readinessDeadline = Date.now() + 5_000;
      while (!existsSync(readinessPath)) {
        if (Date.now() >= readinessDeadline) throw new Error('timed out waiting for resistant runtime readiness');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const started = Date.now();
      const report = await terminal.stop();
      const elapsed = Date.now() - started;

      expect(report.warnings).toEqual([]);
      expect(calls).toEqual(['runtime', 'following']);
      expect(processStopReport).toEqual({ selected: [processRecord.id], stopped: [processRecord.id], failed: [] });
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
