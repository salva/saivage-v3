import { describe, it, expect } from '@jest/globals';

import {
  Runtime,
  ActiveRuntime,
  initRuntimeState,
  readRuntimeState,
  runtimeStatePath,
  startProcess,
  waitProcess,
  listProcesses,
} from '../../src/runtime/index.js';
import { ActiveRuntime as LifecycleActiveRuntime } from '../../src/runtime/lifecycle.js';
import { Runtime as CompatRuntime } from '../../src/utils/runtime.js';
import { ActiveRuntime as CompatActiveRuntime } from '../../src/utils/active-runtime.js';
import { initRuntimeState as compatInitRuntimeState, runtimeStatePath as compatRuntimeStatePath } from '../../src/utils/runtime-state.js';
import { startProcess as compatStartProcess, waitProcess as compatWaitProcess, listProcesses as compatListProcesses } from '../../src/utils/process-runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';

describe('runtime module boundary and compatibility shims', () => {
  it('exports scheduler and active runtime lifecycle surfaces from src/runtime and old utils shims', () => {
    expect(Runtime).toBe(CompatRuntime);
    expect(ActiveRuntime).toBe(LifecycleActiveRuntime);
    expect(ActiveRuntime).toBe(CompatActiveRuntime);
  });

  it('exports runtime state helpers from new boundary and compatibility shim with identical behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-state-'));
    try {
      initProjectTree(root);
      const state = initRuntimeState(root);
      expect(compatRuntimeStatePath(root)).toBe(runtimeStatePath(root));
      expect(compatInitRuntimeState).toBe(initRuntimeState);
      expect(readRuntimeState(root)).toMatchObject({ project_id: state.project_id, status: 'idle' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports durable process helpers from new boundary and compatibility shim with shared module state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-process-'));
    try {
      initProjectTree(root);
      expect(compatStartProcess).toBe(startProcess);
      expect(compatListProcesses).toBe(listProcesses);
      const rec = startProcess(root, 'echo runtime-boundary', { cardId: 'card-boundary' });
      expect(compatWaitProcess).toBe(waitProcess);
      expect(compatListProcesses(root).map((p) => p.id)).toContain(rec.id);
      await waitProcess(root, rec.id, 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
