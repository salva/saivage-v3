import { describe, expect, it } from '@jest/globals';
import { activeRunFromActivationState, activationStateFromActiveRun, reduceActivation } from '../../src/runtime/activation-reducer.js';
import { CardActivation } from '../../src/runtime/card-activation.js';
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
    expect(state).toEqual({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 2 });
    expect(activeRunFromActivationState(state!, 't1')).toEqual(expect.objectContaining({ card_id: 'goal-a', phase: 'planner', planner_session_id: 'planner:goal-a' }));
  });

  it('emits unwind effects on completion', () => {
    expect(reduceActivation({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 0 }, { type: 'complete', outcome: 'done' })).toEqual({
      state: { phase: 'completed', cardId: 'goal-a', outcome: 'done' },
      effects: [{ kind: 'unwindActivation', cardId: 'goal-a', outcome: 'done' }],
    });
  });

  it('CardActivation coordinates reducer state updates without owning phase behavior', () => {
    const activation = new CardActivation({ phase: 'planner', cardId: 'goal-a', plannerSessionId: 'planner:goal-a', correctionAttempts: 0 });
    const decision = activation.dispatch({ type: 'cancelRequested', reason: 'operator' });
    expect(decision.effects).toEqual([{ kind: 'cancelActivation', cardId: 'goal-a', reason: 'operator' }]);
    expect(activation.state.phase).toBe('planner');
  });
});
