import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ManagedProcessScope, type ProcessCategory } from '../../src/runtime/process-runner.js';

export interface TestProcessRunnerComposition {
  registry: ManagedProcessGroupRegistry;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  analystProcessRootScope: ManagedProcessScope;
  mcpProcessRootScope: ManagedProcessScope;
}

export function createTestProcessRunner(projectRoot: string): TestProcessRunnerComposition {
  const registry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
  const analystProcessRootScope = registry.createContainerScope(registry.rootScope, 'analyst-sessions');
  const mcpProcessRootScope = registry.createContainerScope(registry.rootScope, 'mcp-servers');
  return {
    registry,
    processRunner: new ProcessRunner(projectRoot, registry),
    runtimeProcessRootScope,
    analystProcessRootScope,
    mcpProcessRootScope,
  };
}

export function createTestDirectProcessScope(composition: TestProcessRunnerComposition, category: ProcessCategory): ManagedProcessScope {
  const parent = category === 'runtime_card'
    ? composition.runtimeProcessRootScope
    : category === 'operator_session'
      ? composition.analystProcessRootScope
      : composition.mcpProcessRootScope;
  return composition.processRunner.createDirectScope(parent, `test-${category}`, category);
}
