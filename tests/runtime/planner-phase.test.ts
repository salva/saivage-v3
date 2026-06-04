import { describe, expect, it } from '@jest/globals';
import { buildPlannerActivationPlanningPatch, buildPlannerActiveRunPatch, buildPlannerBlockedDecision, buildPlannerContinuePatch, buildPlannerInvocationFailureBlocker, buildProjectPlannerRetryPatch, decideGoalActivationTransition, decidePlannerPostDispatch, describeProjectPlannerRetry, getActiveTokenBudgetPlanningBlocker, hasPlannerAction, planPlannerActivationSetup, shouldBlockNonActionableContinue, summarizePlannerPostDispatch } from '../../src/runtime/phases/planner-phase.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { PlannerResult } from '../../src/contracts/index.js';

function plannerResult(status: PlannerResult['status']): PlannerResult {
  return { status, summary: 'summary', created_cards: [], updated_cards: [] } as PlannerResult;
}

describe('planner phase decisions', () => {
  it('decides goal activation transition action by card status', () => {
    expect(decideGoalActivationTransition('active')).toEqual({ kind: 'none' });
    expect(decideGoalActivationTransition('backlog')).toEqual({ kind: 'transition', action: 'start' });
    expect(decideGoalActivationTransition('failed')).toEqual({ kind: 'transition', action: 'restart' });
    expect(decideGoalActivationTransition('cancelled')).toEqual({ kind: 'transition', action: 'restart' });
    expect(decideGoalActivationTransition('needs_verification')).toEqual({ kind: 'invalid_status' });
  });

  it('detects whether a planner result had durable action', () => {
    expect(hasPlannerAction({ createdCardIds: [], updatedCardIds: [], hasGoalDispatch: false, hasUnfinishedChildWork: false, executedTerminal: false })).toBe(false);
    expect(hasPlannerAction({ createdCardIds: ['a'], updatedCardIds: [], hasGoalDispatch: false, hasUnfinishedChildWork: false, executedTerminal: false })).toBe(true);
  });

  it('blocks non-actionable continue results only when no action occurred', () => {
    expect(shouldBlockNonActionableContinue({ plannerResult: plannerResult('continue'), hasPlannerAction: false })).toBe(true);
    expect(shouldBlockNonActionableContinue({ plannerResult: plannerResult('continue'), hasPlannerAction: true })).toBe(false);
    expect(shouldBlockNonActionableContinue({ plannerResult: plannerResult('done'), hasPlannerAction: false })).toBe(false);
  });

  it('detects active token-budget planning blockers on planner done', () => {
    const card = { result: { planning: { status: 'blocked', resume_reason: 'planner_context_length_exceeded', failure_kind: 'token_budget_exceeded' } } } as unknown as CardRecord;
    expect(getActiveTokenBudgetPlanningBlocker({ plannerResult: plannerResult('done'), currentCard: card })).toEqual({ currentCard: card, currentPlanning: card.result!.planning });
    expect(getActiveTokenBudgetPlanningBlocker({ plannerResult: plannerResult('continue'), currentCard: card })).toBeNull();
  });

  it('builds generic and reviewer-unavailable planner blocker planning payloads', () => {
    expect(buildPlannerBlockedDecision({ currentCard: null, plannerBlockedReason: 'blocked', createdCardIds: ['a'], updatedCardIds: [] })).toEqual({
      blockedReason: 'blocked',
      planning: { status: 'blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked', created_cards: ['a'], updated_cards: [] },
      terminalReason: 'planner_blocked',
    });
    expect(buildPlannerBlockedDecision({ currentCard: null, plannerBlockedReason: 'report_goal_done reviewer unavailable: exhausted', createdCardIds: [], updatedCardIds: ['b'] })).toEqual(expect.objectContaining({
      blockedReason: 'report_goal_done reviewer unavailable: exhausted',
      terminalReason: 'reviewer_invocation_failed',
      planning: expect.objectContaining({ resume_reason: 'reviewer_unavailable', failure_kind: 'reviewer_invocation_failed', updated_cards: ['b'] }),
    }));
  });

  it('builds planner invocation failure blockers', () => {
    expect(buildPlannerInvocationFailureBlocker({ tokenBudgetFailure: true, providerStatus: 400 })).toEqual(expect.objectContaining({
      resumeReason: 'planner_context_length_exceeded',
      failureKind: 'token_budget_exceeded',
      planning: expect.objectContaining({ provider_status: 400 }),
    }));
    expect(buildPlannerInvocationFailureBlocker({ tokenBudgetFailure: false, providerStatus: 400 })).toEqual(expect.objectContaining({
      resumeReason: 'planner_terminal_tool_exhausted',
      failureKind: 'planner_contract_terminal_tool_exhausted',
      planning: expect.objectContaining({ provider_status: null }),
    }));
  });

  it('does not build legacy planner continue lifecycle overlays', () => {
    expect(buildPlannerContinuePatch({
      existingResult: {
        previous: true,
        planning: {
          persisted_history_compacted: true,
          previous_failure_kind: 'token_budget_exceeded',
        },
      },
      plannerDeclaredDone: true,
      hasUnfinishedChildWork: true,
      hasGoalDispatch: false,
      createdCardIds: ['created-a'],
      updatedCardIds: ['updated-a'],
    })).toEqual({});
  });

  it('decides post-dispatch blocked planner results', () => {
    expect(decidePlannerPostDispatch({
      plannerResult: { ...plannerResult('blocked'), blocked_reason: 'blocked by planner' },
      currentCard: null,
      createdCardIds: ['created-a'],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: false,
      executedTerminal: false,
      isProjectCard: false,
    })).toEqual({
      kind: 'block',
      blockedReason: 'blocked by planner',
      planning: { status: 'blocked', blocked_reason: 'blocked by planner', resume_reason: 'planner_blocked', created_cards: ['created-a'], updated_cards: [] },
      terminalReason: 'planner_blocked',
    });
  });

  it('decides non-actionable continue and project done blockers', () => {
    const continueDecision = decidePlannerPostDispatch({
      plannerResult: plannerResult('continue'),
      currentCard: null,
      createdCardIds: [],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: false,
      executedTerminal: false,
      isProjectCard: false,
    });
    expect(continueDecision).toEqual(expect.objectContaining({ kind: 'block', terminalReason: 'planner_non_actionable_continue' }));
    expect((continueDecision as { planning: Record<string, unknown> }).planning.resume_reason).toBe('non_actionable_continue');

    const projectDoneDecision = decidePlannerPostDispatch({
      plannerResult: plannerResult('done'),
      currentCard: null,
      createdCardIds: [],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: false,
      executedTerminal: false,
      isProjectCard: true,
    });
    expect(projectDoneDecision).toEqual(expect.objectContaining({ kind: 'block', terminalReason: 'planner_non_actionable_project_done' }));
    expect((projectDoneDecision as { planning: Record<string, unknown> }).planning.resume_reason).toBe('non_actionable_project_done');
  });

  it('decides ready-for-review, continue, and unfinished-child-work outcomes', () => {
    expect(decidePlannerPostDispatch({
      plannerResult: plannerResult('done'),
      currentCard: null,
      createdCardIds: ['created-a'],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: false,
      executedTerminal: false,
      isProjectCard: false,
    })).toEqual({ kind: 'ready_for_review' });

    expect(decidePlannerPostDispatch({
      plannerResult: plannerResult('continue'),
      currentCard: null,
      createdCardIds: ['created-a'],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: false,
      executedTerminal: false,
      isProjectCard: false,
    })).toEqual(expect.objectContaining({ kind: 'continue', patch: {} }));

    expect(decidePlannerPostDispatch({
      plannerResult: plannerResult('done'),
      currentCard: null,
      createdCardIds: [],
      updatedCardIds: [],
      hasGoalDispatch: false,
      hasUnfinishedChildWork: true,
      executedTerminal: false,
      isProjectCard: false,
    })).toEqual(expect.objectContaining({ kind: 'exit_with_unfinished_child_work', terminalReason: 'planner_done_with_unfinished_child_work' }));
  });

  it('summarizes post-dispatch planner action inputs', () => {
    expect(summarizePlannerPostDispatch({
      plannerResult: {
        ...plannerResult('continue'),
        created_cards: [{ id: 'created-a' } as any, {} as any],
        updated_cards: [{ id: 'updated-a' } as any],
      },
      goalId: 'goal-a',
      childCards: [
        { parent: 'goal-a', status: 'done' },
        { parent: 'goal-a', status: 'active' },
        { parent: 'other', status: 'active' },
      ] as any,
    })).toEqual({
      createdCardIds: ['created-a'],
      updatedCardIds: ['updated-a'],
      hasUnfinishedChildWork: true,
    });
  });

  it('builds planner active-run runtime state patches', () => {
    expect(buildPlannerActiveRunPatch({
      goal: { id: 'goal-a', type: 'goal' } as any,
      plannerSessionId: 'planner:goal-a',
      at: 'now',
    })).toEqual({
      status: 'running',
      current_card_id: 'goal-a',
      current_agent_session_id: 'planner:goal-a',
      active_card_run: expect.objectContaining({
        card_id: 'goal-a',
        card_type: 'goal',
        phase: 'planner',
        planner_session_id: 'planner:goal-a',
        started_at: 'now',
        last_turn_at: 'now',
      }),
    });
  });

  it('plans activation setup from refreshed card planning metadata', () => {
    const retry = planPlannerActivationSetup({
      goalId: 'goal-a',
      initialStatus: 'blocked',
      refreshedCard: {
        status: 'active',
        result: { previous: true, planning: { status: 'blocked', resume_reason: 'planner_context_length_exceeded', failure_kind: 'token_budget_exceeded' } },
      } as unknown as CardRecord,
    });
    expect(retry).toEqual(expect.objectContaining({
      plannerSessionId: 'planner:goal-a',
      retryingTokenBudgetBlocker: true,
      retryingPlanningBlocker: true,
      shouldCompactPersistedPlannerHistory: true,
      shouldUpdatePlanning: true,
    }));
    expect(retry.existingResult).toEqual(expect.objectContaining({ previous: true }));

    expect(planPlannerActivationSetup({
      goalId: 'goal-a',
      initialStatus: 'active',
      refreshedCard: { status: 'active', result: null } as unknown as CardRecord,
    })).toEqual(expect.objectContaining({
      existingPlanning: null,
      retryingPlanningBlocker: false,
      shouldCompactPersistedPlannerHistory: true,
      shouldUpdatePlanning: true,
    }));
  });

  it('builds planner activation patches without lifecycle overlays', () => {
    const patch = buildPlannerActivationPlanningPatch({
      existingResult: { previous: true },
      existingError: 'old error',
      existingStatusText: 'old status',
      retryingTokenBudgetBlocker: true,
      retryingTerminalToolBlocker: false,
      compactedPersistedPlannerHistory: true,
    });
    expect(patch).toEqual({ status_text: null });
  });

  it('builds project planner retry patches and descriptions', () => {
    const patch = buildProjectPlannerRetryPatch({
      existingResult: { previous: true },
      retryingTokenBudgetBlocker: false,
      compactedPersistedPlannerHistory: true,
    });
    expect(patch).toEqual({ status: 'active', result: null, error: null, completed_at: null, status_text: null });
    expect(describeProjectPlannerRetry({ retryingTokenBudgetBlocker: true }).intentReason).toContain('token-budget blocker');
    expect(describeProjectPlannerRetry({ retryingTokenBudgetBlocker: false }).diagnosticMessage).toContain('terminal-tool exhaustion');
  });
});
