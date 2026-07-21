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
  it.each(['runtime', 'mcp'] as const)('starts exactly one %s root termination synchronously and rejects a failed report', async (component) => {
    const termination = deferred<ProcessStopReport>();
    const terminateScopeTree = jest.fn(() => termination.promise);
    const runner = { terminateScopeTree };
    const rootScope = {};
    let cleanup: Promise<void>;
    if (component === 'runtime') {
      const runtime = new SupervisorRuntimeApi({
        runtimeGate: { close: jest.fn() },
        interventionBinding: {},
        processRunner: runner,
        runtimeProcessRootScope: rootScope,
      } as never);
      cleanup = runtime.cleanupForApplicationStop();
    } else {
      const mcp = new McpManager({ configAuthority: {}, processRunner: runner, mcpProcessRootScope: rootScope, eventLogger: { appendEvent() {} } } as never);
      cleanup = mcp.cleanupForApplicationStop();
    }

    expect(terminateScopeTree).toHaveBeenCalledTimes(1);
    expect(terminateScopeTree).toHaveBeenCalledWith({
      rootScope,
      categories: [component === 'runtime' ? 'runtime_card' : 'service_infrastructure'],
      reason: 'application stopping',
      graceMs: 5000,
    });
    termination.resolve(failedReport);
    await expect(cleanup).rejects.toThrow(`${component === 'mcp' ? 'MCP' : component[0]!.toUpperCase() + component.slice(1)} application cleanup failed.`);
  });

  it.each(['runtime', 'mcp'] as const)('accepts an empty %s process report', async (component) => {
    const runner = { terminateScopeTree: jest.fn(async () => emptyReport) };
    const rootScope = {};
    const cleanup = component === 'runtime'
      ? new SupervisorRuntimeApi({ runtimeGate: { close: jest.fn() }, interventionBinding: {}, processRunner: runner, runtimeProcessRootScope: rootScope } as never).cleanupForApplicationStop()
      : new McpManager({ configAuthority: {}, processRunner: runner, mcpProcessRootScope: rootScope, eventLogger: { appendEvent() {} } } as never).cleanupForApplicationStop();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it('starts the narrow Analyst root operation synchronously and preserves root report failure', async () => {
    const termination = deferred<ProcessStopReport>();
    const terminateRoot = jest.fn((_reason: string) => termination.promise);
    const analyst = new AnalystRuntime({ createSession: jest.fn(), getAvailableToolNames: jest.fn(), terminateRoot } as never);

    const cleanup = analyst.cleanupForApplicationStop();

    expect(terminateRoot).toHaveBeenCalledWith('application stopping');
    termination.resolve(failedReport);
    await expect(cleanup).rejects.toThrow('Analyst application cleanup failed.');
  });

  it('accepts an empty Analyst root report', async () => {
    const analyst = new AnalystRuntime({ createSession: jest.fn(), getAvailableToolNames: jest.fn(), terminateRoot: jest.fn(async () => emptyReport) } as never);
    await expect(analyst.cleanupForApplicationStop()).resolves.toBeUndefined();
  });
});
