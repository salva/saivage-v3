import { describe, it, expect } from '@jest/globals';

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
import { initRuntimeState, runtimeStatePath } from '../../src/runtime/state.js';
import { readRuntimeState as directReadRuntimeState, updateRuntimeState as directUpdateRuntimeState, appendRuntimeRun as directAppendRuntimeRun, upsertRuntimeActivation as directUpsertRuntimeActivation } from '../../src/runtime/state.js';
import { listProcesses as directListProcesses, tailOutput as directTailOutput, getProcess as directGetProcess } from '../../src/runtime/process-runner.js';
import { pauseRuntimeControl as directPauseRuntimeControl, resumeRuntimeControl as directResumeRuntimeControl, RESUME_FROM_FREEZE_MESSAGE as directResumeFromFreezeMessage } from '../../src/runtime/control.js';
import { readFreezeManifest as directReadFreezeManifest, clearFreezeManifest as directClearFreezeManifest } from '../../src/runtime/freeze-manifest.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';

describe('runtime module ownership boundary', () => {
  function listTypeScriptFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) return listTypeScriptFiles(fullPath);
      return fullPath.endsWith('.ts') ? [fullPath] : [];
    });
  }

  it('keeps ActiveRuntime out of public runtime barrels', async () => {
    const runtimeRoot = await import('../../src/runtime/index.js');
    const controlApi = await import('../../src/runtime/control-api.js');
    const lifecycle = await import('../../src/runtime/lifecycle.js');
    expect('ActiveRuntime' in runtimeRoot).toBe(false);
    expect('ActiveRuntime' in controlApi).toBe(false);
    expect('ActiveRuntime' in lifecycle).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/active-runtime.ts'))).toBe(false);
  });

  it('keeps RuntimeApi independent from concrete Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-api.ts'), 'utf8');
    expect(source).not.toContain("from './runtime.js'");
    expect(source).not.toContain('ReturnType<Runtime');
  });

  it('keeps public runtime barrels independent from concrete Runtime', () => {
    for (const filePath of ['src/runtime/index.ts', 'src/runtime/state-api.ts']) {
      const source = readFileSync(join(process.cwd(), filePath), 'utf8');
      expect(source).not.toContain("from './runtime.js'");
      expect(source).not.toContain('from "./runtime.js"');
    }
  });

  it('keeps tests on the runtime test harness instead of concrete Runtime imports', () => {
    const singleQuoteRuntimeImport = "from '../../src/runtime/" + "runtime.js'";
    const doubleQuoteRuntimeImport = 'from "../../src/runtime/' + 'runtime.js"';
    const singleQuoteActiveRuntimeImport = "from '../../src/runtime/" + "active-runtime.js'";
    const doubleQuoteActiveRuntimeImport = 'from "../../src/runtime/' + 'active-runtime.js"';
    const runtimeConstructor = 'new ' + 'Runtime(';
    for (const filePath of listTypeScriptFiles(join(process.cwd(), 'tests'))) {
      if (filePath.endsWith('tests/utils/runtime-module-boundary.test.ts')) continue;
      const source = readFileSync(filePath, 'utf8');
      expect(source).not.toContain(singleQuoteRuntimeImport);
      expect(source).not.toContain(doubleQuoteRuntimeImport);
      expect(source).not.toContain(singleQuoteActiveRuntimeImport);
      expect(source).not.toContain(doubleQuoteActiveRuntimeImport);
      expect(source).not.toContain(runtimeConstructor);
      expect(source).not.toContain('runtime.dispatchGoal');
      expect(source).not.toContain('dispatchGoal =');
      expect(source).not.toContain('runtime.getBackgroundDispatchCount');
      expect(source).not.toContain('runtime.simulateCrash');
      expect(source).not.toContain('runtime.emitAgentEvent');
      expect(source).not.toContain('runtime.on(');
      expect(source).not.toContain('runtime.performCrashRecovery');
      expect(source).not.toContain('runtime._stateMachine');
      expect(source).not.toContain('runtime.lastLifecycleDisposeReport');
      expect(source).not.toContain('runtime.consumeResumeHandoffContext');
      expect(source).not.toContain('runtime.getState(');
      expect(source).not.toContain('runtime.cardStore');
      expect(source).not.toContain('runtime.agentRuntime');
      expect(source).not.toContain('runtime.errorLogger');
      expect(source).not.toContain('runtime.eventLogger');
      expect(source).not.toContain('runtime.supervisor');
      expect(source).not.toContain('harness.runtime.cardStore');
      expect(source).not.toContain('harness.runtime.agentRuntime');
      expect(source).not.toContain('harness.agentRuntime.');
      expect(source).not.toContain('harness.runtime.errorLogger');
      expect(source).not.toContain('harness.runtime.eventLogger');
      expect(source).not.toContain('harness.errorLogger.');
      expect(source).not.toContain('harness.eventLogger.');
      expect(source).not.toContain('harness.runtime.supervisor');
      expect(source).not.toContain('harness.eventBus');
      expect(source).not.toContain('harness.runtime.projectRoot');
      expect(source).not.toContain('harness.runtime.on(');
      expect(source).not.toContain('harness.runtime.emitAgentEvent');
      expect(source).not.toContain('harness.runtime.performCrashRecovery');
      expect(source).not.toContain('harness.runtime._stateMachine');
      expect(source).not.toContain('harness.supervisor.');
      expect(source).not.toContain("RuntimeTestHarness['runtime']");
      expect(source).not.toContain('runtime.projectRoot');
    }
  });

  it('keeps RuntimeCoreContainer from exposing concrete Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/core-composition.ts'), 'utf8');
    expect(source).not.toContain('  runtime: Runtime;');
    expect(source).not.toContain('agentEventBus: runtime');
  });

  it('keeps runtime core independent from ActiveRuntime adapter', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime.ts'), 'utf8');
    expect(source).not.toContain("../agents/");
    expect(source).not.toContain('active-runtime.js');
    expect(source).not.toContain('ActiveRuntimeStampCounter');
    expect(source).not.toContain('ActiveRuntimeStampSource');
    expect(source).not.toContain('_activeRuntime');
    expect(source).not.toContain('setActiveRuntime');
    expect(source).not.toContain('config.activeRuntime');
    expect(source).not.toContain('activeRuntime: this._');
    expect(source).not.toContain('extends EventEmitter');
    expect(source).not.toContain('start_project()');
    expect(source).not.toContain('stop_project()');
    expect(source).not.toContain('runCleanup(');
    expect(source).not.toContain('trackProcessStarted(');
    expect(source).not.toContain('trackProcessStopped(');
    expect(source).not.toContain('readonly runningProcesses');
    expect(source).not.toContain('  readonly cardStore');
    expect(source).not.toContain('  readonly projectRoot');
    expect(source).not.toContain('  readonly agentRuntime');
    expect(source).not.toContain('  readonly eventBus');
    expect(source).not.toContain('  get eventLogger(');
    expect(source).not.toContain('  get errorLogger(');
    expect(source).not.toContain('  get supervisor(');
    expect(source).not.toContain('  get status(');
    expect(source).not.toContain('  get paused(');
    expect(source).not.toContain('  emitAgentEvent(');
    expect(source).not.toContain('  registerArtifactOnCard(');
    expect(source).not.toContain('  registerAttachmentOnCard(');
    expect(source).not.toContain('  getBackgroundDispatchCount(');
    expect(source).not.toContain('  get lastLifecycleDisposeReport(');
    expect(source).not.toContain('  async simulateCrash(');
    expect(source).not.toContain('  freeze(');
    expect(source).not.toContain('  resumeFromFreeze(');
    expect(source).not.toContain('  async performCrashRecovery(');
    expect(source).not.toContain('  async dispatchGoal(');
    expect(source).not.toContain('  emit(');
    expect(source).not.toContain('  async startProject(');
    expect(source).not.toContain('  async stopProject(');
    expect(source).not.toContain('  async startup(');
    expect(source).not.toContain('  async shutdown(');
    expect(source).not.toContain('  pause(');
    expect(source).not.toContain('  resume(');
    expect(source).not.toContain('  consumeResumeHandoffContext(');
    expect(source).not.toContain('  getState(');
    expect(source).not.toContain('../agents/skills-engine.js');
    expect(source).not.toContain('../agents/system-prompt.js');
    expect(source).not.toContain('../agents/analyst-stage6.js');
  });

  it('keeps application extras outside the RuntimeApi shape', () => {
    const source = readFileSync(join(process.cwd(), 'src/application/runtime-composition.ts'), 'utf8');
    expect(source).toContain('readonly runtimeApi: RuntimeApi');
    expect(source).not.toContain('runtimeCore.runtime;');
    expect(source).not.toContain('interface RuntimeApplication extends RuntimeApi');
    expect(source).not.toContain('active-runtime.js');
    expect(source).not.toContain('new ActiveRuntime');
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
