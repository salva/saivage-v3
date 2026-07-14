import { describe, expect, it, jest } from '@jest/globals';

import { runAuditedAnalystTool, type AnalystMutationContext } from '../../src/agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from '../../src/tools/analyst-tool-types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('concurrent Analyst preparation', () => {
  it('rechecks current state after overlapping preparation and commits without yielding', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let version = 0;
    const commits: string[] = [];
    const health = { assertMutationHealthy: jest.fn(), snapshot: jest.fn(), reportUncertainFailure: jest.fn() };
    const readiness = { assertInterventionReady: jest.fn(), snapshot: jest.fn() };
    const services = {} as NonNullable<ToolContext['analystMutations']>;
    const ctx = { actor: 'analyst', surface: 'web-chat', projectRoot: '/project', persistenceHealth: health, interventionReadiness: readiness, analystMutations: services, analystPreparation: { web: { fetchText: jest.fn() } }, appLogs: { append: jest.fn() }, eventBus: undefined } as unknown as ToolContext;
    const commit = (prepared: string, _input: { id: string }, _ctx: AnalystMutationContext): ToolResult => {
      commits.push(prepared);
      version += 1;
      return { success: true, data: { version } };
    };
    const spec = (promise: Promise<string>) => ({ action: 'card.concurrent', safety_class: 'low' as const, target_kind: 'card' as const, getTargetId: (input: { id: string }) => input.id, lifecycle: 'intervention_ready' as const, prepare: () => promise, recheck: (_prepared: string, input: { id: string }) => version === 0 || input.id === 'second' ? { allowed: true as const } : { allowed: false as const, reason: 'stale version' }, commit });

    const firstRun = runAuditedAnalystTool(ctx, { id: 'first' }, spec(first.promise));
    const secondRun = runAuditedAnalystTool(ctx, { id: 'second' }, spec(second.promise));
    second.resolve('second-content');
    await expect(secondRun).resolves.toMatchObject({ success: true });
    first.resolve('first-content');
    await expect(firstRun).resolves.toMatchObject({ success: false });
    expect(commits).toEqual(['second-content']);
    expect(health.assertMutationHealthy).toHaveBeenCalledTimes(4);
    expect(readiness.assertInterventionReady).toHaveBeenCalledTimes(2);
  });
});
