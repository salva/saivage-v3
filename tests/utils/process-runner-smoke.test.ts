import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

describe('ProcessRunner smoke', () => {
  it('waits for a managed command to settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-runner-smoke-'));
    const registry = new ManagedProcessGroupRegistry();
    const runtimeRootScope = registry.createContainerScope(registry.rootScope, 'runtime');
    const runner = new ProcessRunner(root, registry);
    const scope = runner.createDirectScope(runtimeRootScope, 'smoke', 'runtime_card');
    try {
      const record = runner.spawn({ command: 'exit 0', directScope: scope, category: 'runtime_card', ownerId: 'smoke', ownerKind: 'agent' });
      await expect(runner.waitForSettlement(record.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
    } finally {
      await runner.terminateScopeTree({ rootScope: runtimeRootScope, categories: ['runtime_card'], reason: 'cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
