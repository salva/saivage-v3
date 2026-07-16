import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ManagedProcessScope, type ProcessCategory } from '../../src/runtime/process-runner.js';

export function createTestProcessRunner(projectRoot: string): ProcessRunner {
  return new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
}

export function createTestDirectProcessScope(runner: ProcessRunner, category: ProcessCategory): ManagedProcessScope {
  const parent = category === 'runtime_card'
    ? runner.runtimeRootScope
    : category === 'operator_session'
      ? runner.analystRootScope
      : runner.mcpRootScope;
  return runner.createDirectScope(parent, `test-${category}`, category);
}
