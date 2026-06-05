import { describe, expect, it } from '@jest/globals';
import { activeRunFromActivationState, plannerActivationStateFromGoal } from '../../src/runtime/activation-reducer.js';
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

describe('activation planner shapers', () => {
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

  it('preserves existing planner active run metadata when shaping runtime state', () => {
    expect(activeRunFromActivationState({
      phase: 'planner',
      cardId: 'goal-a',
      plannerSessionId: 'planner:goal-a',
      correctionAttempts: 2,
      activeRun: plannerRun,
    }, 't1')).toEqual(plannerRun);
  });
});
