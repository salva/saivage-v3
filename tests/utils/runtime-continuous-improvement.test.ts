import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { startProcess, snapshotProcessRuntimeScope } from '../../src/runtime/process-runner.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Runtime continuousImprovement reserved config', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let harness: RuntimeCoreTestContainer | undefined;

  function createRuntime(config: Omit<Parameters<typeof createRuntimeCoreTestContainer>[0]['config'], 'projectRoot' | 'fakeAgentConfig'> & {
    fakeAgentConfig: Parameters<typeof createRuntimeCoreTestContainer>[0]['config']['fakeAgentConfig'];
  }): void {
    harness = createRuntimeCoreTestContainer({
      config: { projectRoot: tmpDir, ...config },
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ci-noop-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (harness) {
      try { await harness.api.shutdown(); } catch {}
    }
    try { releaseLock(tmpDir); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runtime shutdown is idempotent and disposes the process lifecycle scope before logger close', async () => {
    createRuntime({
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    await harness!.api.start();
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-runtime-shutdown', ownerKind: 'runtime' });
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await harness!.api.shutdown();
    await harness!.api.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(harness?.diagnosticTestTools.getLastLifecycleDisposeReport()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'child_process', status: expect.stringMatching(/detached|killed/) }),
    ]));
  });

  it('partial startup failure releases runtime-owned process scope resources', async () => {
    createRuntime({
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-partial-startup', ownerKind: 'runtime' });
    await harness!.api.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await import('../../src/runtime/process-runner.js').then(({ disposeProcessRuntimeScope }) => disposeProcessRuntimeScope(tmpDir));
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(rec.id).toMatch(/^proc-/);
  });

});
