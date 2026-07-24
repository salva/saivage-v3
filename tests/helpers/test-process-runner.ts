import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ManagedProcessScope, type ProcessCategory } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from './test-application-fatal-port.js';

export interface TestProcessRunnerComposition {
  registry: ManagedProcessGroupRegistry;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  analystProcessRootScope: ManagedProcessScope;
  mcpProcessRootScope: ManagedProcessScope;
}

const compositionsByRoot = new Map<string, TestProcessRunnerComposition[]>();

export function createTestProcessRunner(projectRoot: string): TestProcessRunnerComposition {
  const registry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
  const analystProcessRootScope = registry.createContainerScope(registry.rootScope, 'analyst-sessions');
  const mcpProcessRootScope = registry.createContainerScope(registry.rootScope, 'mcp-servers');
  const composition = {
    registry,
    processRunner: new ProcessRunner(projectRoot, registry, testApplicationFatalPort),
    runtimeProcessRootScope,
    analystProcessRootScope,
    mcpProcessRootScope,
  };
  const compositions = compositionsByRoot.get(projectRoot) ?? [];
  compositions.push(composition);
  compositionsByRoot.set(projectRoot, compositions);
  return composition;
}

export async function cleanupTestProcessRunners(projectRoot: string): Promise<void> {
  const compositions = compositionsByRoot.get(projectRoot) ?? [];
  compositionsByRoot.delete(projectRoot);
  await Promise.all(compositions.map(async ({ registry, processRunner }) => {
    const report = await processRunner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card', 'operator_session', 'service_infrastructure'], reason: 'test cleanup', graceMs: 1000 });
    if (report.failed.length > 0) throw new Error('Test process cleanup failed.');
  }));
}

export function createTestDirectProcessScope(composition: TestProcessRunnerComposition, category: ProcessCategory): ManagedProcessScope {
  const parent = category === 'runtime_card'
    ? composition.runtimeProcessRootScope
    : category === 'operator_session'
      ? composition.analystProcessRootScope
      : composition.mcpProcessRootScope;
  return composition.processRunner.createDirectScope(parent, `test-${category}`, category);
}
