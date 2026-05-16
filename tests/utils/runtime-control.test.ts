import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRuntimeState } from '../../src/utils/runtime-state.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../src/utils/runtime-control.js';
import { startRuntime, type ActiveRuntime } from '../../src/utils/active-runtime.js';

describe('runtime-control live handle integration', () => {
  let projectRoot: string;
  let runtime: ActiveRuntime;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-'));
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0', type: 'module' }));
    initializeRuntimeState(projectRoot);
    runtime = startRuntime({ projectRoot });
  });

  afterEach(async () => {
    await runtime.stop();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('pause_runtime updates both runtime state and active loop handle', () => {
    const result = pauseRuntimeControl({ projectRoot, activeRuntime: runtime });
    expect(result.ok).toBe(true);
    expect(result.paused).toBe(true);
    expect(runtime.state.paused).toBe(true);

    const statePath = join(projectRoot, '.saivage', 'runtime-state.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(persisted.paused).toBe(true);
  });

  it('resume_runtime updates both runtime state and active loop handle', () => {
    pauseRuntimeControl({ projectRoot, activeRuntime: runtime });

    const result = resumeRuntimeControl({ projectRoot, activeRuntime: runtime });
    expect(result.ok).toBe(true);
    expect(result.paused).toBe(false);
    expect(runtime.state.paused).toBe(false);

    const statePath = join(projectRoot, '.saivage', 'runtime-state.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(persisted.paused).toBe(false);
  });
});
