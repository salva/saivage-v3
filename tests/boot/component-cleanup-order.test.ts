import { describe, expect, it, jest } from '@jest/globals';
import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { ProcessStopReport } from '../../src/runtime/process-runner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const emptyReport: ProcessStopReport = { selected: [], stopped: [], failed: [] };
const failedReport: ProcessStopReport = { selected: ['p'], stopped: [], failed: [{ groupId: 'p', state: 'unconfirmed', diagnostic: 'private diagnostic' }] };

describe('termination-first component cleanup', () => {
  it.each(['runtime', 'analyst', 'mcp'] as const)('starts exactly one %s root termination synchronously and rejects a failed report', async (component) => {
    const termination = deferred<ProcessStopReport>();
    const terminateOwnedRoot = jest.fn(() => termination.promise);
    const runner = { runtimeRootScope: {}, analystRootScope: {}, mcpRootScope: {}, terminateOwnedRoot };
    let cleanup: Promise<void>;
    if (component === 'runtime') {
      const runtime = new SupervisorRuntimeApi({
        runtimeGate: { close: jest.fn() },
        interventionBinding: {},
        processRunner: runner,
      } as never);
      cleanup = runtime.cleanupForApplicationStop();
    } else if (component === 'analyst') {
      const analyst = new AnalystRuntime({ runtimeDeps: { processRunner: runner, analystProcessRootScope: runner.analystRootScope } } as never);
      cleanup = analyst.cleanupForApplicationStop();
    } else {
      const mcp = new McpManager({ configAuthority: {}, processRunner: runner } as never);
      cleanup = mcp.cleanupForApplicationStop();
    }

    expect(terminateOwnedRoot).toHaveBeenCalledTimes(1);
    expect(terminateOwnedRoot).toHaveBeenCalledWith(component, runner[`${component}RootScope`], 'application stopping');
    termination.resolve(failedReport);
    await expect(cleanup).rejects.toThrow(`${component === 'mcp' ? 'MCP' : component[0]!.toUpperCase() + component.slice(1)} application cleanup failed.`);
  });

  it.each(['runtime', 'analyst', 'mcp'] as const)('accepts an empty %s process report', async (component) => {
    const runner = { runtimeRootScope: {}, analystRootScope: {}, mcpRootScope: {}, terminateOwnedRoot: jest.fn(async () => emptyReport) };
    const cleanup = component === 'runtime'
      ? new SupervisorRuntimeApi({ runtimeGate: { close: jest.fn() }, interventionBinding: {}, processRunner: runner } as never).cleanupForApplicationStop()
      : component === 'analyst'
        ? new AnalystRuntime({ runtimeDeps: { processRunner: runner, analystProcessRootScope: runner.analystRootScope } } as never).cleanupForApplicationStop()
        : new McpManager({ configAuthority: {}, processRunner: runner } as never).cleanupForApplicationStop();
    await expect(cleanup).resolves.toBeUndefined();
  });
});
