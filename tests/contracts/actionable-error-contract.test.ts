import { describe, expect, it } from '@jest/globals';
import { actionableEnumError, createActionableErrorEnvelope } from '../../src/schemas/validators.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';

describe('actionable error envelope target contract (Wave 1)', () => {
  it('invalid planner-state values return accepted values and a next action', () => {
    const error = actionableEnumError('planner_state', 'ready', ['drafting', 'backlog', 'active']);
    expect(error).toEqual(expect.objectContaining({ code: 'invalid_enum_value', acceptedValues: ['drafting', 'backlog', 'active'] }));
    expect(error.nextAction).toContain('Retry');
  });

  it('runtime command precondition errors can carry current intent/run context', () => {
    const error = createActionableErrorEnvelope({ code: 'runtime_start_precondition_failed', message: 'already running', currentState: { intent: 'running', runId: 'run-1' }, nextAction: 'Use stop_project before starting another root run.', runId: 'run-1' });
    expect(error.currentState).toEqual(expect.objectContaining({ intent: 'running' }));
    expect(error.nextAction).toContain('stop_project');
  });

  it('activation precondition errors carry parent/child context', () => {
    const error = createActionableErrorEnvelope({ code: 'activate_card_parent_not_active', message: 'No active parent planner run.', parentCardId: 'goal-a', childCardId: 'code-a', sessionId: 'planner:goal-a', currentState: { parentRunId: null }, nextAction: 'Call activate_card only from the active parent planner run.' });
    expect(error).toEqual(expect.objectContaining({ parentCardId: 'goal-a', childCardId: 'code-a', sessionId: 'planner:goal-a' }));
  });

  it('REST runtime command errors use the same actionable envelope', () => {
    const actionable_error = createActionableErrorEnvelope({
      code: 'runtime_unavailable',
      message: 'ActiveRuntime is not attached.',
      currentState: { command: 'start_project' },
      nextAction: 'Start the server with runtime creation enabled before retrying start_project.',
      docsRef: 'docs/operation.md#start-project',
    });
    const parsed = operatorApiContracts['runtime.startProject'].error.safeParse({ success: false, actionable_error });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.actionable_error.nextAction).toContain('start_project');
  });
});
