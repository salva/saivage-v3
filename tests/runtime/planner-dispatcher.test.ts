import { describe, expect, it, jest } from '@jest/globals';
import { RuntimePlannerDispatcher, type RuntimePlannerDispatcherDeps } from '../../src/runtime/runtime-planner-dispatcher.js';
import { createLifecycleFlags } from '../../src/runtime/runtime-lifecycle-state.js';
import { PlannerActivationRunner } from '../../src/runtime/phases/planner-activation-runner.js';
import { PlannerIterationRunner } from '../../src/runtime/phases/planner-iteration-runner.js';

function makeDeps(overrides: Partial<RuntimePlannerDispatcherDeps> = {}): RuntimePlannerDispatcherDeps {
  const lifecycle = createLifecycleFlags();
  lifecycle.paused = true;
  return {
    projectRoot: '/tmp/project',
    cards: {} as RuntimePlannerDispatcherDeps['cards'],
    agentRuntime: {} as RuntimePlannerDispatcherDeps['agentRuntime'],
    skillsEngine: () => null,
    eventLogger: { appendEvent: jest.fn() } as unknown as RuntimePlannerDispatcherDeps['eventLogger'],
    errorLogger: { appendError: jest.fn() } as unknown as RuntimePlannerDispatcherDeps['errorLogger'],
    stateMachine: {} as RuntimePlannerDispatcherDeps['stateMachine'],
    goalContext: {} as RuntimePlannerDispatcherDeps['goalContext'],
    pendingActivations: {} as RuntimePlannerDispatcherDeps['pendingActivations'],
    reviewerDispatcher: {} as RuntimePlannerDispatcherDeps['reviewerDispatcher'],
    mutations: {} as RuntimePlannerDispatcherDeps['mutations'],
    runLedger: {} as RuntimePlannerDispatcherDeps['runLedger'],
    sessionStamper: {} as RuntimePlannerDispatcherDeps['sessionStamper'],
    lifecycle,
    emit: jest.fn(),
    publishRuntimeDiagnostic: jest.fn(),
    goalDispatcher: undefined,
    plannerFailureHandler: {} as RuntimePlannerDispatcherDeps['plannerFailureHandler'],
    now: () => '2026-06-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('RuntimePlannerDispatcher dispatch seam', () => {
  it('dispatches directly when no custom goal dispatcher is configured', async () => {
    const deps = makeDeps();
    await new RuntimePlannerDispatcher(deps).dispatchGoal('goal-a');
    expect(deps.emit).toHaveBeenCalledWith('dispatch_blocked', { reason: 'paused', goal_id: 'goal-a' });
  });

  it('lets a custom goal dispatcher intercept dispatch', async () => {
    const goalDispatcher = jest.fn(async (_goalId: string, _dispatch: (goalId: string) => Promise<void>) => undefined);
    const deps = makeDeps({ goalDispatcher });
    await new RuntimePlannerDispatcher(deps).dispatchGoal('goal-a');
    expect(goalDispatcher).toHaveBeenCalledWith('goal-a', expect.any(Function));
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('reactivates the goal after reviewer corrections before continuing planner loop', async () => {
    const lifecycle = createLifecycleFlags();
    const activate = jest.spyOn(PlannerActivationRunner.prototype, 'activate').mockResolvedValue({} as never);
    const runIteration = jest.spyOn(PlannerIterationRunner.prototype, 'run')
      .mockResolvedValueOnce({ kind: 'continue', plannerDone: true, planningContext: { kind: 'planner_done', summary: 'ready' } })
      .mockResolvedValueOnce({ kind: 'shutdown' });
    const reviewerDispatcher = { runReviewer: jest.fn(async () => false) } as unknown as RuntimePlannerDispatcherDeps['reviewerDispatcher'];
    const deps = makeDeps({
      lifecycle,
      cards: { read: jest.fn(() => null) } as unknown as RuntimePlannerDispatcherDeps['cards'],
      reviewerDispatcher,
    });

    await new RuntimePlannerDispatcher(deps).dispatchGoal('goal-a');

    expect(reviewerDispatcher.runReviewer).toHaveBeenCalledWith('goal-a', { kind: 'planner_done', summary: 'ready' });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(runIteration).toHaveBeenCalledTimes(2);
    activate.mockRestore();
    runIteration.mockRestore();
  });
});
