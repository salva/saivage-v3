import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';

describe('ProcessRunner smoke', () => {
  it('waits for a managed command to settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-runner-smoke-'));
    const runner = createTestProcessRunner(root);
    const scope = runner.createDirectScope(runner.runtimeRootScope, 'smoke', 'runtime_card');
    try {
      const record = runner.spawn({ command: 'exit 0', directScope: scope, category: 'runtime_card', ownerId: 'smoke', ownerKind: 'agent' });
      await expect(runner.waitForSettlement(record.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
    } finally {
      await runner.terminateScopeTree({ rootScope: runner.runtimeRootScope, categories: ['runtime_card'], reason: 'cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
