import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { AgentAdapter, createAgentAdapter } from '../../src/agents/agent-adapter.js';
import { createRuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

describe('Runtime caller-edge reconstruction from unresolved activate_card calls', () => {
  let tmpDir: string;
  let fixtureDir: string;
  function makeFixtureDir(baseDir: string): string { const dir = join(baseDir, 'fixtures'); mkdirSync(dir, { recursive: true }); return dir; }

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'saivage-project-loop-')); fixtureDir = makeFixtureDir(tmpDir); initProjectTree(tmpDir); materializeProjectCard(tmpDir); });
  afterEach(() => { try { releaseLock(tmpDir); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

  it('preserves public harness and adapter APIs', () => {
    const harness = createRuntimeCoreTestContainer({
      config: { projectRoot: tmpDir, fakeAgentConfig: { mapping: {}, fixtureDir } },
    });
    expect(typeof harness.eventTestTools.emitAgentEvent).toBe('function');
    expect(typeof AgentAdapter.prototype.getSafeFileContent).toBe('function');
    expect(typeof createAgentAdapter).toBe('function');
  });
});
