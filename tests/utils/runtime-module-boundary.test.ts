import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, it, expect } from '@jest/globals';

import {
  readRuntimeState,
} from '../../src/runtime/state-api.js';
import {
  pauseRuntimeControl,
  resumeRuntimeControl,
} from '../../src/runtime/control-api.js';
import { runtimeStatePath, readRuntimeState as directReadRuntimeState } from '../../src/runtime/state.js';
import { initRuntimeState } from '../helpers/runtime-state.js';
import { pauseRuntimeControl as directPauseRuntimeControl, resumeRuntimeControl as directResumeRuntimeControl } from '../../src/runtime/control.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


describe('runtime module ownership boundary', () => {
  function listTypeScriptFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) return listTypeScriptFiles(fullPath);
      return fullPath.endsWith('.ts') ? [fullPath] : [];
    });
  }

  it('keeps ActiveRuntime out of public runtime API modules', async () => {
    const controlApi = await import('../../src/runtime/control-api.js');
    const processRegistry = await import('../../src/runtime/managed-process-group-registry.js');
    const runtimeApi = await import('../../src/runtime/runtime-api.js');
    const stateApi = await import('../../src/runtime/state-api.js');
    expect('ActiveRuntime' in controlApi).toBe(false);
    expect('ActiveRuntime' in processRegistry).toBe(false);
    expect('ActiveRuntime' in runtimeApi).toBe(false);
    expect('ActiveRuntime' in stateApi).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/active-runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'tests/utils/runtime-test-harness.ts'))).toBe(false);
  });

  it('keeps RuntimeApi independent from concrete Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-api.ts'), 'utf8');
    expect(source).not.toContain("from './runtime.js'");
    expect(source).not.toContain('ReturnType<Runtime');
  });

  it('keeps public runtime API modules independent from concrete Runtime', () => {
    for (const filePath of ['src/runtime/control-api.ts', 'src/runtime/managed-process-group-registry.ts', 'src/runtime/runtime-api.ts', 'src/runtime/state-api.ts']) {
      const source = readFileSync(join(process.cwd(), filePath), 'utf8');
      expect(source).not.toContain("from './runtime.js'");
      expect(source).not.toContain('from "./runtime.js"');
      expect(source).not.toContain('RuntimeConfig');
      expect(source).not.toContain('RuntimeSkillsPort');
      expect(source).not.toContain('RuntimeStampSource');
    }
  });

  it('keeps public runtime state API read-only', async () => {
    const stateApi = await import('../../src/runtime/state-api.js');
    expect('readRuntimeState' in stateApi).toBe(true);
    expect('updateRuntimeState' in stateApi).toBe(false);
    expect('appendRuntimeRun' in stateApi).toBe(false);
    expect('upsertRuntimeActivation' in stateApi).toBe(false);
  });

  it('keeps runtime state mutations inside RuntimeStateStore', () => {
    const allowed = new Set([join(process.cwd(), 'src/runtime/state.ts')]);
    const writerImportPattern = /import\s+\{[^}]*\b(saveRuntimeState|updateRuntimeState|appendRuntimeCommand|appendRuntimeRun|updateRuntimeRun|upsertRuntimeActivation)\b[^}]*\}\s+from ['"]\.\/state\.js['"]/;
    for (const filePath of listTypeScriptFiles(join(process.cwd(), 'src/runtime'))) {
      if (allowed.has(filePath)) continue;
      expect(readFileSync(filePath, 'utf8')).not.toMatch(writerImportPattern);
    }
    expect(existsSync(join(process.cwd(), 'src/runtime/mutations.ts'))).toBe(false);
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
      expect(source).not.toContain('harness.cards.');
      expect(source).not.toContain("RuntimeCoreTestContainer['cards']");
      expect(source).not.toContain('harness.runtime.agentRuntime');
      expect(source).not.toContain('harness.agentRuntime.');
      expect(source).not.toContain('harness.runtime.errorLogger');
      expect(source).not.toContain('harness.runtime.eventLogger');
      expect(source).not.toContain('harness.errorLogger.');
      expect(source).not.toContain('harness.eventLogger.');
      expect(source).not.toContain('harness.runtime.supervisor');
      expect(source).not.toContain('harness.eventBus');
      expect(source).not.toContain('harness.events.');
      expect(source).not.toContain("RuntimeCoreTestContainer['events']");
      expect(source).not.toContain('harness.diagnostics.');
      expect(source).not.toContain("RuntimeCoreTestContainer['diagnostics']");
      expect(source).not.toContain('harness.state.');
      expect(source).not.toContain("RuntimeCoreTestContainer['state']");
      expect(source).not.toContain('harness.scheduler');
      expect(source).not.toContain("RuntimeCoreTestContainer['scheduler']");
      expect(source).not.toContain('harness.runtime.projectRoot');
      expect(source).not.toContain('harness.runtime.on(');
      expect(source).not.toContain('harness.runtime.emitAgentEvent');
      expect(source).not.toContain('harness.runtime.performCrashRecovery');
      expect(source).not.toContain('harness.runtime._stateMachine');
      expect(source).not.toContain('harness.supervisor.');
      expect(source).not.toContain("RuntimeCoreTestContainer['runtime']");
      expect(source).not.toContain('runtime.projectRoot');
    }
  });

  it('removes obsolete concrete runtime composition files', () => {
    expect(existsSync(join(process.cwd(), 'src/runtime/agent-runtime-factory.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/core-composition.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-config.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-dispatch-composition.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-planner-dispatcher.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-reviewer-dispatcher.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/pending-activation-dispatcher.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/executor-activation-dispatcher.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-lifecycle-controller.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-iteration-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-activation-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-phase-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/executor-phase-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/reviewer-phase-runner.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/executor-completion-handler.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/executor-evidence.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/executor-invocation-failure.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/executor-phase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-invocation-failure.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-phase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-post-dispatch-handler.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/reviewer-assessment-handler.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/reviewer-invocation-failure.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/reviewer-phase.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-startup.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-shutdown.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-project-commands.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-pause-resume.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-services.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-run-ledger.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/activation-repair.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/activation-unwind.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/startup-repair.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/phases/planner-failure-handler.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/runtime-core.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/state-machine.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/startup-blocked-planning.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/startup-run-reconciliation.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'src/runtime/stuck-agent-supervisor.ts'))).toBe(false);
  });

  it('keeps application extras outside the RuntimeApi shape', () => {
    const source = readFileSync(join(process.cwd(), 'src/application/runtime-composition.ts'), 'utf8');
    expect(source).toContain('readonly runtimeApi: RuntimeApi');
    expect(source).toContain('createMicroActorRuntimeApi');
    expect(source).not.toContain('createRuntimeCoreContainer');
    expect(source).not.toContain('core-composition.js');
    expect(source).not.toContain('runtime-planner-dispatcher');
    expect(source).not.toContain('pending-activation-dispatcher');
    expect(source).not.toContain('executor-activation-dispatcher');
    expect(source).not.toContain('runtime-reviewer-dispatcher');
    expect(source).not.toContain('activation-unwind');
    expect(source).not.toContain('runtimeCore.runtime;');
    expect(source).not.toContain('interface RuntimeApplication extends RuntimeApi');
    expect(source).not.toContain('active-runtime.js');
    expect(source).not.toContain('new ActiveRuntime');
  });

  it('keeps old concrete runtime core quarantined from application and production entrypoints', () => {
    const forbiddenRuntimeCoreImports = [
      'runtime/runtime.js',
      'runtime/core-composition.js',
      'runtime/runtime-dispatch-composition.js',
    ];

    for (const filePath of listTypeScriptFiles(join(process.cwd(), 'src'))) {
      const relativePath = filePath.slice(process.cwd().length + 1);
      const source = readFileSync(filePath, 'utf8');
      for (const forbiddenImport of forbiddenRuntimeCoreImports) {
        expect(source).not.toContain(forbiddenImport);
      }

      if (relativePath.startsWith('src/application/')) {
        expect(source).not.toContain('core-composition.js');
        expect(source).not.toContain('initializeRuntimeImplementation');
        expect(source).not.toContain('RuntimeConfig');
        expect(source).not.toContain('RuntimeAssembly');
      }
    }
  });

  it('exports source-proven runtime state reads through state-api', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-boundary-state-'));
    try {
      initProjectTree(root);
      const state = initRuntimeState(root);
      expect(existsSync(runtimeStatePath(root))).toBe(true);
      expect(readRuntimeState).toBe(directReadRuntimeState);
      expect(readRuntimeState(root)).toMatchObject({ project_id: state.project_id, status: 'stopped' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports runtime-owned pause/resume authority through control-api', () => {
    expect(pauseRuntimeControl).toBe(directPauseRuntimeControl);
    expect(resumeRuntimeControl).toBe(directResumeRuntimeControl);
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
