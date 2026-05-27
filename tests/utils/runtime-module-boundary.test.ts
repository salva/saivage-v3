import { describe, it, expect } from '@jest/globals';

import { ActiveRuntime } from '../../src/runtime/index.js';
import { ActiveRuntime as ControlApiActiveRuntime } from '../../src/runtime/control-api.js';
import {
  readRuntimeState,
  updateRuntimeState,
  appendRuntimeRun,
  upsertRuntimeActivation,
} from '../../src/runtime/state-api.js';
import {
  listProcesses,
  tailOutput,
  getProcess,
} from '../../src/runtime/process-api.js';
import {
  pauseRuntimeControl,
  resumeRuntimeControl,
  RESUME_FROM_FREEZE_MESSAGE,
  readFreezeManifest,
  clearFreezeManifest,
} from '../../src/runtime/control-api.js';
import { ActiveRuntime as LifecycleActiveRuntime } from '../../src/runtime/lifecycle.js';
import { ActiveRuntime as RuntimeActiveRuntime } from '../../src/runtime/active-runtime.js';
import { initRuntimeState, runtimeStatePath } from '../../src/runtime/state.js';
import { readRuntimeState as directReadRuntimeState, updateRuntimeState as directUpdateRuntimeState, appendRuntimeRun as directAppendRuntimeRun, upsertRuntimeActivation as directUpsertRuntimeActivation } from '../../src/runtime/state.js';
import { listProcesses as directListProcesses, tailOutput as directTailOutput, getProcess as directGetProcess } from '../../src/runtime/process-runner.js';
import { pauseRuntimeControl as directPauseRuntimeControl, resumeRuntimeControl as directResumeRuntimeControl, RESUME_FROM_FREEZE_MESSAGE as directResumeFromFreezeMessage } from '../../src/runtime/control.js';
import { readFreezeManifest as directReadFreezeManifest, clearFreezeManifest as directClearFreezeManifest } from '../../src/runtime/freeze-manifest.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';

describe('runtime module ownership boundary', () => {
  it('keeps the runtime root limited to the stable runtime handle', () => {
    expect(ActiveRuntime).toBe(LifecycleActiveRuntime);
    expect(ActiveRuntime).toBe(RuntimeActiveRuntime);
    expect(ActiveRuntime).toBe(ControlApiActiveRuntime);
  });

  it('exports source-proven runtime state helpers through state-api', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-state-'));
    try {
      initProjectTree(root);
      const state = initRuntimeState(root);
      expect(existsSync(runtimeStatePath(root))).toBe(true);
      expect(readRuntimeState).toBe(directReadRuntimeState);
      expect(updateRuntimeState).toBe(directUpdateRuntimeState);
      expect(appendRuntimeRun).toBe(directAppendRuntimeRun);
      expect(upsertRuntimeActivation).toBe(directUpsertRuntimeActivation);
      expect(readRuntimeState(root)).toMatchObject({ project_id: state.project_id, status: 'idle' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports source-proven process inspection helpers through process-api', () => {
    expect(listProcesses).toBe(directListProcesses);
    expect(tailOutput).toBe(directTailOutput);
    expect(getProcess).toBe(directGetProcess);
  });

  it('exports runtime-owned pause/resume and freeze authority through control-api', () => {
    expect(pauseRuntimeControl).toBe(directPauseRuntimeControl);
    expect(resumeRuntimeControl).toBe(directResumeRuntimeControl);
    expect(RESUME_FROM_FREEZE_MESSAGE).toBe(directResumeFromFreezeMessage);
    expect(readFreezeManifest).toBe(directReadFreezeManifest);
    expect(clearFreezeManifest).toBe(directClearFreezeManifest);
  });

  it('does not retain legacy src/utils runtime compatibility or ownership files', () => {
    expect(existsSync(join(process.cwd(), 'src/utils/runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/active-runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-state.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/process-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-control.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/runtime-lock.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/utils/freeze-manifest.ts'))).toBe(false);
  });
});
