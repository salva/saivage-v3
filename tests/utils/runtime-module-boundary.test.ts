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
  pauseRuntimeControl,
  resumeRuntimeControl,
  RESUME_FROM_FREEZE_MESSAGE,
  acquireLock,
  releaseLock,
  isLocked,
  removeStaleLock,
} from '../../src/runtime/index.js';
import { Runtime as SchedulerRuntime } from '../../src/runtime/runtime.js';
import { ActiveRuntime as LifecycleActiveRuntime } from '../../src/runtime/lifecycle.js';
import { ActiveRuntime as RuntimeActiveRuntime } from '../../src/runtime/active-runtime.js';
import { initRuntimeState as directInitRuntimeState, runtimeStatePath as directRuntimeStatePath } from '../../src/runtime/state.js';
import { startProcess as directStartProcess, waitProcess as directWaitProcess, listProcesses as directListProcesses } from '../../src/runtime/process-runner.js';
import { pauseRuntimeControl as directPauseRuntimeControl, resumeRuntimeControl as directResumeRuntimeControl, RESUME_FROM_FREEZE_MESSAGE as directResumeFromFreezeMessage } from '../../src/runtime/control.js';
import { acquireLock as directAcquireLock, releaseLock as directReleaseLock, isLocked as directIsLocked, removeStaleLock as directRemoveStaleLock } from '../../src/runtime/lock.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';

describe('runtime module ownership boundary', () => {
  it('exports scheduler and active runtime lifecycle surfaces only through src/runtime', () => {
    expect(Runtime).toBe(SchedulerRuntime);
    expect(ActiveRuntime).toBe(LifecycleActiveRuntime);
    expect(ActiveRuntime).toBe(RuntimeActiveRuntime);
  });

  it('exports runtime state helpers from the src/runtime index with identical direct-module behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-state-'));
    try {
      initProjectTree(root);
      const state = initRuntimeState(root);
      expect(directRuntimeStatePath(root)).toBe(runtimeStatePath(root));
      expect(directInitRuntimeState).toBe(initRuntimeState);
      expect(readRuntimeState(root)).toMatchObject({ project_id: state.project_id, status: 'idle' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports durable process helpers from the src/runtime index with shared direct-module state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-process-'));
    try {
      initProjectTree(root);
      expect(directStartProcess).toBe(startProcess);
      expect(directListProcesses).toBe(listProcesses);
      const rec = startProcess(root, 'echo runtime-boundary', { cardId: 'card-boundary' });
      expect(directWaitProcess).toBe(waitProcess);
      expect(directListProcesses(root).map((p) => p.id)).toContain(rec.id);
      await waitProcess(root, rec.id, 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports runtime-owned pause/resume control authority from the src/runtime index', () => {
    expect(pauseRuntimeControl).toBe(directPauseRuntimeControl);
    expect(resumeRuntimeControl).toBe(directResumeRuntimeControl);
    expect(RESUME_FROM_FREEZE_MESSAGE).toBe(directResumeFromFreezeMessage);
  });

  it('exports runtime lock ownership from the src/runtime index with direct-module identity', () => {
    expect(acquireLock).toBe(directAcquireLock);
    expect(releaseLock).toBe(directReleaseLock);
    expect(isLocked).toBe(directIsLocked);
    expect(removeStaleLock).toBe(directRemoveStaleLock);
  });

  it('does not retain legacy src/utils runtime compatibility or ownership files', () => {
    expect(existsSync(join(process.cwd(), 'src/utils/runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/active-runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-state.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/process-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-control.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-lock.ts'))).toBe(false);
  });
});
