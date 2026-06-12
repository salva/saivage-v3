import { describe, it, expect } from '@jest/globals';

import {
  readRuntimeState,
} from '../../src/runtime/state-api.js';
import {
  processApi,
} from '../../src/runtime/process-api.js';
import {
  pauseRuntimeControl,
  resumeRuntimeControl,
} from '../../src/runtime/control-api.js';
import { initRuntimeState, runtimeStatePath } from '../../src/runtime/state.js';
import { readRuntimeState as directReadRuntimeState, updateRuntimeState as directUpdateRuntimeState, appendRuntimeRun as directAppendRuntimeRun, upsertRuntimeActivation as directUpsertRuntimeActivation } from '../../src/runtime/state.js';
import { pauseRuntimeControl as directPauseRuntimeControl, resumeRuntimeControl as directResumeRuntimeControl } from '../../src/runtime/control.js';
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
    expect(existsSync(join(process.cwd(), 'tests/utils/runtime-test-harness.ts'))).toBe(false);
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

  it('keeps runtime state writers behind the mutation port', () => {
    const allowed = new Set([
      join(process.cwd(), 'src/runtime/state.ts'),
      join(process.cwd(), 'src/runtime/mutations.ts'),
    ]);
    const writerImportPattern = /import\s+\{[^}]*\b(saveRuntimeState|updateRuntimeState|appendRuntimeCommand|upsertRuntimeIntent|appendRuntimeRun|updateRuntimeRun|upsertRuntimeActivation)\b[^}]*\}\s+from ['"]\.\/state\.js['"]/;
    for (const filePath of listTypeScriptFiles(join(process.cwd(), 'src/runtime'))) {
      if (allowed.has(filePath)) continue;
      expect(readFileSync(filePath, 'utf8')).not.toMatch(writerImportPattern);
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

  it('keeps RuntimeCoreContainer from exposing concrete Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/core-composition.ts'), 'utf8');
    expect(source).not.toContain('  runtime: Runtime;');
    expect(source).not.toContain('agentEventBus: runtime');
    expect(source).not.toContain('RuntimeInternalParts');
    expect(source).not.toContain('internalsSink');
    expect(source).not.toContain('._runCheck(');
  });

  it('keeps production runtime core composition free of test tools', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/core-composition.ts'), 'utf8');
    const start = source.indexOf('export interface RuntimeCoreContainer');
    const end = source.indexOf('export interface RuntimeCoreTestContainer');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const productionInterface = source.slice(start, end);
    expect(productionInterface).not.toContain('TestTools');
    expect(productionInterface).not.toContain('cardTestTools');
    expect(productionInterface).not.toContain('lifecycleTestTools');
    expect(productionInterface).not.toContain('agentEventBus');
    expect(productionInterface).not.toContain('runtimeLedgerEvents');
    expect(productionInterface).not.toContain('emitAnalystToolInvoked');
    const productionFactoryStart = source.indexOf('export function createRuntimeCoreContainer');
    const testFactoryStart = source.indexOf('export function createRuntimeCoreTestContainer');
    expect(productionFactoryStart).toBeGreaterThanOrEqual(0);
    expect(testFactoryStart).toBeGreaterThan(productionFactoryStart);
    const productionFactory = source.slice(productionFactoryStart, testFactoryStart);
    expect(productionFactory).not.toContain('createRuntimeCoreTestContainer');
    expect(productionFactory).not.toContain('testPartsSink');
    expect(productionFactory).not.toContain('lifecycleTestToolsSink');
  });

  it('keeps production runtime core parts free of concrete card mutation authority', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-config.ts'), 'utf8');
    const start = source.indexOf('export interface RuntimeCoreParts');
    const end = source.indexOf('export type RuntimeCardTestStore');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const coreParts = source.slice(start, end);
    expect(coreParts).not.toContain('CardStore');
    expect(coreParts).not.toContain('cards:');
    expect(coreParts).not.toContain('EventBus');
    expect(coreParts).toContain('countGoals');
  });

  it('keeps RuntimeConfig free of composition sinks', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-config.ts'), 'utf8');
    const start = source.indexOf('export interface RuntimeConfig');
    expect(start).toBeGreaterThanOrEqual(0);
    const runtimeConfig = source.slice(start);
    expect(runtimeConfig).not.toContain('Sink');
    expect(runtimeConfig).not.toContain('setRuntime');
    expect(runtimeConfig).not.toContain('setDispatchGoal');
    expect(source).not.toContain('RuntimeStampSource');
  });

  it('keeps construction parts explicit and diagnostics observer-only', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime-config.ts'), 'utf8');
    expect(source).not.toContain('RuntimeCompositionHooks');
    expect(source).not.toContain('RuntimeTestHooks');
    expect(source).not.toContain('corePartsSink');
    expect(source).not.toContain('controlSink');
    expect(source).not.toContain('testPartsSink');

    const assemblyStart = source.indexOf('export interface RuntimeAssembly');
    const configStart = source.indexOf('export interface RuntimeConfig');
    expect(assemblyStart).toBeGreaterThanOrEqual(0);
    expect(configStart).toBeGreaterThan(assemblyStart);
    const assembly = source.slice(assemblyStart, configStart);
    expect(assembly).toContain('controls: RuntimeControls');
    expect(assembly).toContain('coreParts: RuntimeCoreParts');
    expect(assembly).toContain('testParts?: RuntimeTestAssemblyParts');
    expect(assembly).not.toContain('Diagnostics');
  });

  it('keeps agent event emission out of lifecycle test tools', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/core-composition.ts'), 'utf8');
    const lifecycleToolsStart = source.indexOf('  lifecycleTestTools: {');
    const lifecycleToolsEnd = source.indexOf('\n  };\n}', lifecycleToolsStart);
    expect(lifecycleToolsStart).toBeGreaterThanOrEqual(0);
    expect(lifecycleToolsEnd).toBeGreaterThan(lifecycleToolsStart);
    const lifecycleTools = source.slice(lifecycleToolsStart, lifecycleToolsEnd);
    expect(lifecycleTools).not.toContain('emitAgentEvent');
  });

  it('keeps runtime core independent from ActiveRuntime adapter', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime.ts'), 'utf8');
    expect(source).not.toContain("../agents/");
    expect(source).not.toContain('active-runtime.js');
    expect(source).not.toContain('ActiveRuntimeStampCounter');
    expect(source).not.toContain('ActiveRuntimeStampSource');
    expect(source).not.toContain('_activeRuntime');
    expect(source).not.toContain('export class Runtime');
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
    expect(source).not.toContain('notificationCenter');
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

  it('keeps lifecycle implementation wiring out of concrete Runtime', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime.ts'), 'utf8');
    expect(source).toContain('RuntimeLifecycleController');
    expect(source).not.toContain('performRuntimeStartup');
    expect(source).not.toContain('performRuntimeShutdown');
    expect(source).not.toContain('performRuntimeCrashRecovery');
    expect(source).not.toContain('repairRuntimeStartupActiveCardRun');
  });

  it('keeps application extras outside the RuntimeApi shape', () => {
    const source = readFileSync(join(process.cwd(), 'src/application/runtime-composition.ts'), 'utf8');
    expect(source).toContain('readonly runtimeApi: RuntimeApi');
    expect(source).toContain('createXStateRuntimeApi');
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
      'runtime/core-composition.js',
      'runtime/runtime.js',
      'runtime/runtime-config.js',
    ];

    for (const filePath of listTypeScriptFiles(join(process.cwd(), 'src'))) {
      const relativePath = filePath.slice(process.cwd().length + 1);
      if (
        relativePath === 'src/runtime/runtime.ts' ||
        relativePath === 'src/runtime/core-composition.ts' ||
        relativePath === 'src/runtime/runtime-config.ts'
      ) {
        continue;
      }

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
      expect(readRuntimeState(root)).toMatchObject({ project_id: state.project_id, status: 'idle' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports semantic process inspection through process-api', () => {
    const api = processApi(process.cwd());
    expect(typeof api.listForRuntime).toBe('function');
    expect(typeof api.listForAgent).toBe('function');
    expect(typeof api.listForOperator).toBe('function');
    expect(typeof api.getForOperator).toBe('function');
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
