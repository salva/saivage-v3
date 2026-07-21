import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppTerminalCoordinator } from '../../src/boot/app.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

describe('App real managed-process cleanup', () => {
  it('allows production TERM grace, KILL escalation, and absence verification inside the App bound', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-app-process-cleanup-'));
    try {
      const registry = new ManagedProcessGroupRegistry();
      const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
      const runner = new ProcessRunner(projectRoot, registry);
      const scope = runner.createDirectScope(runtimeProcessRootScope, 'resistant-runtime', 'runtime_card');
      const processRecord = runner.spawn({
        command: "trap '' TERM; while true; do sleep 1; done",
        directScope: scope,
        category: 'runtime_card',
        cardId: 'project',
        ownerId: 'runtime-test',
        ownerKind: 'runtime',
      });
      const calls: string[] = [];
      const terminal = createAppTerminalCoordinator();
      terminal.registerCleanupLeaf('fastify', () => { calls.push('following'); });
      terminal.registerCleanupLeaf('runtime', async () => {
        calls.push('runtime');
        const report = await runner.terminateScopeTree({ rootScope: runtimeProcessRootScope, categories: ['runtime_card'], reason: 'application stopping', graceMs: 5_000 });
        if (report.failed.length !== 0) throw new Error('managed process cleanup failed');
      });

      const started = Date.now();
      const report = await terminal.stop();
      const elapsed = Date.now() - started;

      expect(report.warnings).toEqual([]);
      expect(calls).toEqual(['runtime', 'following']);
      expect(registry.isLive(processRecord.id)).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
