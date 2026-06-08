import { describe, expect, it } from '@jest/globals';
import { actionableEnumError, createActionableErrorEnvelope } from '../../src/schemas/validators.js';

describe('actionable error envelope target contract (Wave 1)', () => {
  it('invalid planner-state values return accepted values and a next action', () => {
    const error = actionableEnumError('card_status', 'ready', ['backlog', 'running']);
    expect(error).toEqual(expect.objectContaining({ code: 'invalid_enum_value', acceptedValues: ['backlog', 'running'] }));
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

  it('runtime command errors still use actionable envelopes outside the pruned REST contract', () => {
    const actionableError = createActionableErrorEnvelope({
      code: 'runtime_unavailable',
      message: 'Runtime application is not attached.',
      currentState: { command: 'start_project' },
      nextAction: 'Start the runtime before retrying start_project through the Analyst.',
      docsRef: 'docs/operation.md#start-project',
    });
    expect(actionableError.nextAction).toContain('start_project');
  });
});
