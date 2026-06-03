import { describe, expect, it } from '@jest/globals';
import { activeRunFromActivationState, activationStateFromActiveRun, plannerActivationStateFromGoal, reduceActivation } from '../../src/runtime/activation-reducer.js';
import { activationFromRuntimeState, CardActivation } from '../../src/runtime/card-activation.js';
import type { RuntimeState } from '../../src/schemas/types.js';

const plannerRun: NonNullable<RuntimeState['active_card_run']> = {
  card_id: 'goal-a',
  card_type: 'goal',
  runtime_status: 'running',
  phase: 'planner',
  caller_session_id: null,
  caller_tool_call_id: null,
  planner_session_id: 'planner:goal-a',
  correction_attempts: 2,
  started_at: 't0',
  last_turn_at: 't0',
};

describe('activation reducer and CardActivation shell', () => {
  it('round-trips planner active run snapshots', () => {
    const state = activationStateFromActiveRun(plannerRun);
    expect(state).toEqual(expect.objectContaining({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 2 }));
    expect(activeRunFromActivationState(state!, 't1')).toEqual(plannerRun);
  });

  it('builds planner activation state from goal identity without losing card type', () => {
    const state = plannerActivationStateFromGoal({
      goal: { id: 'project', type: 'project' } as any,
      plannerSessionId: 'planner:project',
    });

    expect(activeRunFromActivationState(state, 't1')).toEqual(expect.objectContaining({
      card_id: 'project',
      card_type: 'project',
      phase: 'planner',
      planner_session_id: 'planner:project',
      started_at: 't1',
      last_turn_at: 't1',
    }));
  });

  it('creates a CardActivation from runtime state snapshots', () => {
    expect(activationFromRuntimeState(null)).toBeNull();
    expect(activationFromRuntimeState({ active_card_run: null } as RuntimeState)).toBeNull();
    expect(activationFromRuntimeState({ active_card_run: plannerRun } as RuntimeState)?.state).toEqual(expect.objectContaining({ phase: 'planner', cardId: 'goal-a' }));
  });

  it('round-trips executor active run snapshots without losing caller metadata', () => {
    const executorRun: NonNullable<RuntimeState['active_card_run']> = {
      card_id: 'task-a',
      card_type: 'code',
      runtime_status: 'running',
      phase: 'executor',
      caller_session_id: 'planner:goal-a',
      caller_tool_call_id: 'call-1',
      planner_session_id: 'planner:goal-a',
      executor_session_id: 'executor:task-a',
      correction_attempts: 1,
      started_at: 't0',
      last_turn_at: 't2',
    };
    const state = activationStateFromActiveRun(executorRun);
    expect(state).toEqual(expect.objectContaining({ phase: 'executor', cardId: 'task-a', goalId: 'goal-a', executorSessionId: 'executor:task-a' }));
    expect(activeRunFromActivationState(state!, 't3')).toEqual(executorRun);
  });

  it('round-trips reviewer active run snapshots without losing timestamps', () => {
    const reviewerRun: NonNullable<RuntimeState['active_card_run']> = {
      card_id: 'goal-a',
      card_type: 'goal',
      runtime_status: 'running',
      phase: 'reviewer',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: 'planner:goal-a',
      reviewer_session_id: 'reviewer:goal-a:assessment-1',
      correction_attempts: 3,
      started_at: 't0',
      last_turn_at: 't4',
    };
    const state = activationStateFromActiveRun(reviewerRun);
    expect(state).toEqual(expect.objectContaining({ phase: 'reviewer', cardId: 'goal-a', reviewerSessionId: 'reviewer:goal-a:assessment-1', assessmentId: 'assessment-1' }));
    expect(activeRunFromActivationState(state!, 't5')).toEqual(reviewerRun);
  });

  it('emits unwind effects on completion', () => {
    const decision = reduceActivation({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 0 }, { type: 'complete', outcome: 'done' });
    expect(decision).toEqual({
      state: { phase: 'completed', cardId: 'goal-a', outcome: 'done' },
      effects: [{ kind: 'unwindActivation', cardId: 'goal-a', outcome: 'done' }],
      mutations: [expect.objectContaining({ kind: 'completeActivation', childCardId: 'goal-a', outcome: 'done' })],
    });
  });

  it('CardActivation coordinates reducer state updates without owning phase behavior', () => {
    const activation = new CardActivation({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 0 });
    const decision = activation.dispatch({ type: 'cancelRequested', reason: 'operator' });
    expect(decision.effects).toEqual([{ kind: 'cancelActivation', cardId: 'goal-a', reason: 'operator' }]);
    expect(decision.mutations).toEqual([]);
    expect(activation.state.phase).toBe('planner');
  });
});
