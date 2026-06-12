import { describe, expect, it, jest } from '@jest/globals';
import { RuntimePlannerDispatcher, type RuntimePlannerDispatcherDeps } from '../../src/runtime/runtime-planner-dispatcher.js';
import { createLifecycleFlags } from '../../src/runtime/runtime-lifecycle-state.js';

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

});
