import type { CardRecord, PlannerBlockedResult, RuntimeState } from '../../schemas/index.js';
import type { PlannerResult } from '../../contracts/index.js';
import { blockedPlanningReason, getBlockedPlanning, shouldPreservePrecisePlanningBlocker } from '../planning-blockers.js';
import { activeRunFromActivationState, plannerActivationStateFromGoal } from '../activation-reducer.js';
import { lifecycleCardPatch } from '../terminal-commit/lifecycle-patch.js';

export type GoalActivationTransitionDecision =
  | { kind: 'none' }
  | { kind: 'transition'; action: 'start' | 'restart' }
  | { kind: 'invalid_status' };

export function hasPlannerAction(input: {
  hasGoalDispatch: boolean;
  hasUnfinishedChildWork: boolean;
  executedTerminal: boolean;
}): boolean {
  return (
    input.hasGoalDispatch ||
    input.hasUnfinishedChildWork ||
    input.executedTerminal
  );
}

export function shouldBlockNonActionableContinue(input: {
  plannerResult: PlannerResult;
  hasPlannerAction: boolean;
}): boolean {
  return input.plannerResult.status === 'continue' && !input.hasPlannerAction;
}

export function getActiveTokenBudgetPlanningBlocker(input: {
  plannerResult: PlannerResult;
  currentCard: CardRecord | null | undefined;
}): { currentCard: CardRecord | null; currentPlanning: PlannerBlockedResult } | null {
  if (input.plannerResult.status !== 'done') return null;
  const currentPlanning = getBlockedPlanning(input.currentCard ?? null);
  return currentPlanning &&
    currentPlanning.resume_reason === 'planner_context_length_exceeded' &&
    input.currentCard?.status === 'blocked'
    ? { currentCard: input.currentCard ?? null, currentPlanning }
    : null;
}

export function buildPlannerBlockedDecision(input: {
  currentCard: CardRecord | null | undefined;
  plannerBlockedReason: string | null;
}): { blockedReason: string | null; planning: PlannerBlockedResult; terminalReason: string } {
  const preservePreciseBlocker = shouldPreservePrecisePlanningBlocker(input.currentCard ?? null, 'planner_blocked');
  const preservedPlanning = preservePreciseBlocker ? getBlockedPlanning(input.currentCard ?? null) : null;
  const blockedReason = preservePreciseBlocker
    ? typeof preservedPlanning?.blocked_reason === 'string'
      ? preservedPlanning.blocked_reason
      : (input.currentCard?.lifecycle.error ?? input.currentCard?.status_text ?? input.plannerBlockedReason)
    : input.plannerBlockedReason;
  if (preservePreciseBlocker) {
    return {
      blockedReason,
      planning: {
        ...preservedPlanning,
        kind: 'planner_blocked',
        blocked_reason: blockedReason ?? 'Planner blocked without a reason.',
        resume_reason: 'reviewer_unavailable',
        blocker_cause: 'reviewer_unavailable',
      },
      terminalReason: 'reviewer_invocation_failed',
    };
  }
  return {
    blockedReason,
    planning: {
      kind: 'planner_blocked',
      blocked_reason: input.plannerBlockedReason ?? 'Planner blocked without a reason.',
      resume_reason: 'planner_blocked',
      blocker_cause: 'generic',
    },
    terminalReason: 'planner_blocked',
  };
}

export function buildPlannerInvocationFailureBlocker(input: {
  providerStatus: number | null;
}): { blockedReason: string; resumeReason: string; failureKind: string; planning: PlannerBlockedResult } {
  const blockedReason = 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
  const resumeReason = 'planner_context_length_exceeded';
  const failureKind = 'token_budget_exceeded';
  return {
    blockedReason,
    resumeReason,
    failureKind,
    planning: {
      kind: 'planner_blocked',
      blocked_reason: blockedReason,
      resume_reason: resumeReason,
      blocker_cause: 'token_budget_exceeded',
    },
  };
}

export function buildPlannerContinuePatch(input: {
  existingLifecycle: CardRecord['lifecycle'] | undefined;
  plannerDeclaredDone: boolean;
  hasUnfinishedChildWork: boolean;
  hasGoalDispatch: boolean;
}): Partial<CardRecord> {
  void input;
  return {};
}

export type PlannerPostDispatchDecision =
  | { kind: 'block'; blockedReason: string; planning: PlannerBlockedResult; terminalReason: string }
  | { kind: 'continue'; patch: Partial<CardRecord> }
  | { kind: 'exit_with_unfinished_child_work'; patch: Partial<CardRecord>; terminalReason: string }
  | { kind: 'ready_for_review' };

export function decidePlannerPostDispatch(input: {
  plannerResult: PlannerResult;
  currentCard: CardRecord | null | undefined;
  hasGoalDispatch: boolean;
  hasUnfinishedChildWork: boolean;
  executedTerminal: boolean;
  isProjectCard: boolean;
}): PlannerPostDispatchDecision {
  if (input.plannerResult.status === 'blocked') {
    const decision = buildPlannerBlockedDecision({
      currentCard: input.currentCard,
      plannerBlockedReason: input.plannerResult.blocked_reason ?? null,
    });
    return { kind: 'block', blockedReason: decision.blockedReason ?? '', planning: decision.planning, terminalReason: decision.terminalReason };
  }

  const activeTokenBudgetPlanningBlocker = getActiveTokenBudgetPlanningBlocker({
    plannerResult: input.plannerResult,
    currentCard: input.currentCard,
  });
  if (activeTokenBudgetPlanningBlocker) {
    return {
      kind: 'block',
      blockedReason: blockedPlanningReason(input.currentCard ?? null, activeTokenBudgetPlanningBlocker.currentPlanning),
      planning: activeTokenBudgetPlanningBlocker.currentPlanning,
      terminalReason: 'planner_context_length_exceeded',
    };
  }

  const blockedPlanning = getBlockedPlanning(input.currentCard ?? null);
  if (blockedPlanning) {
    return {
      kind: 'block',
      blockedReason: blockedPlanningReason(input.currentCard ?? null, blockedPlanning),
      planning: blockedPlanning,
      terminalReason: typeof blockedPlanning.resume_reason === 'string' ? blockedPlanning.resume_reason : 'planner_blocked',
    };
  }

  const plannerHadAction = hasPlannerAction({
    hasGoalDispatch: input.hasGoalDispatch,
    hasUnfinishedChildWork: input.hasUnfinishedChildWork,
    executedTerminal: input.executedTerminal,
  });

  if (shouldBlockNonActionableContinue({ plannerResult: input.plannerResult, hasPlannerAction: plannerHadAction })) {
    const blockedReason = 'Planner returned continue without creating/updating cards, activating child work, leaving unfinished child work, or declaring a blocker.';
    return {
      kind: 'block',
      blockedReason,
      planning: {
        kind: 'planner_blocked',
        blocked_reason: blockedReason,
        resume_reason: 'non_actionable_continue',
        blocker_cause: 'non_actionable_continue',
      },
      terminalReason: 'planner_non_actionable_continue',
    };
  }

  if (input.isProjectCard && input.plannerResult.status === 'done' && !plannerHadAction) {
    const blockedReason = 'Project planner returned done without creating/updating cards, activating child work, leaving unfinished child work, producing terminal child output, or declaring a blocker; continuous project runtime requires a durable next milestone or explicit blocker.';
    return {
      kind: 'block',
      blockedReason,
      planning: {
        kind: 'planner_blocked',
        blocked_reason: blockedReason,
        resume_reason: 'non_actionable_project_done',
        blocker_cause: 'non_actionable_continue',
      },
      terminalReason: 'planner_non_actionable_project_done',
    };
  }

  if (input.plannerResult.status === 'done' && !input.hasGoalDispatch && !input.hasUnfinishedChildWork) {
    return { kind: 'ready_for_review' };
  }

  const patch = buildPlannerContinuePatch({
    existingLifecycle: input.currentCard?.lifecycle,
    plannerDeclaredDone: input.plannerResult.status === 'done',
    hasUnfinishedChildWork: input.hasUnfinishedChildWork,
    hasGoalDispatch: input.hasGoalDispatch,
  });
  if (input.plannerResult.status === 'done' && !input.hasGoalDispatch && input.hasUnfinishedChildWork) {
    return { kind: 'exit_with_unfinished_child_work', patch, terminalReason: 'planner_done_with_unfinished_child_work' };
  }
  return { kind: 'continue', patch };
}

export function summarizePlannerPostDispatch(input: {
  plannerResult: PlannerResult;
  childCards: readonly Pick<CardRecord, 'parent' | 'status'>[];
  goalId: string;
}): {
  hasUnfinishedChildWork: boolean;
} {
  return {
    hasUnfinishedChildWork: input.childCards.some(
      (card) =>
        card.parent === input.goalId &&
        card.status !== 'done' &&
        card.status !== 'failed' &&
        card.status !== 'cancelled',
    ),
  };
}

export function buildPlannerActiveRunPatch(input: {
  goal: Pick<CardRecord, 'id' | 'type'>;
  plannerSessionId: string;
  at: string;
}): Partial<RuntimeState> {
  const activeRun = activeRunFromActivationState(
    plannerActivationStateFromGoal({ goal: input.goal, plannerSessionId: input.plannerSessionId }),
    input.at,
  );
  return {
    status: 'running',
    active_card_run: activeRun,
  };
}

export interface PlannerActivationSetup {
  plannerSessionId: string;
  existingResult: CardRecord['lifecycle']['result'];
  existingPlanning: PlannerBlockedResult | null;
  retryingTokenBudgetBlocker: boolean;
  retryingPlanningBlocker: boolean;
  shouldCompactPersistedPlannerHistory: boolean;
  shouldUpdatePlanning: boolean;
}

export function planPlannerActivationSetup(input: {
  goalId: string;
  initialStatus: CardRecord['status'];
  refreshedCard: CardRecord;
}): PlannerActivationSetup {
  const existingResult = input.refreshedCard.lifecycle.result;
  const existingPlanning = getBlockedPlanning(input.refreshedCard);
  const hasTokenBudgetPlanningBlocker =
    existingPlanning?.resume_reason === 'planner_context_length_exceeded';
  const retryingTokenBudgetBlocker =
    input.initialStatus !== 'active' &&
    input.initialStatus !== 'running' &&
    hasTokenBudgetPlanningBlocker;
  const retryingPlanningBlocker = retryingTokenBudgetBlocker;
  return {
    plannerSessionId: `planner:${input.goalId}`,
    existingResult,
    existingPlanning,
    retryingTokenBudgetBlocker,
    retryingPlanningBlocker,
    shouldCompactPersistedPlannerHistory: retryingTokenBudgetBlocker || existingPlanning === null,
    shouldUpdatePlanning: existingPlanning === null || retryingPlanningBlocker,
  };
}

export function buildPlannerActivationPlanningPatch(input: {
  existingResult: CardRecord['lifecycle']['result'];
  existingError: string | null | undefined;
  existingStatusText: string | null | undefined;
  retryingTokenBudgetBlocker: boolean;
  compactedPersistedPlannerHistory: boolean;
}): Partial<CardRecord> {
  const retryingPlanningBlocker = input.retryingTokenBudgetBlocker;
  return {
    status_text: retryingPlanningBlocker ? null : input.existingStatusText,
  };
}

export function buildProjectPlannerRetryPatch(input: {
  existingLifecycle: CardRecord['lifecycle'] | undefined;
  retryingTokenBudgetBlocker: boolean;
  compactedPersistedPlannerHistory: boolean;
}): Partial<CardRecord> {
  void input;
  return {
    ...lifecycleCardPatch({ status: 'active', result: null, error: null, completed_at: null }),
    status_text: null,
  };
}

export function describeProjectPlannerRetry(input: { retryingTokenBudgetBlocker: boolean }): {
  diagnosticMessage: string;
  intentReason: string;
} {
  return input.retryingTokenBudgetBlocker
    ? {
        diagnosticMessage: 'Accepted explicit retry for project planner token-budget blocker after clearing stale blocked planning metadata.',
        intentReason: 'explicit start_project retry for compacted planner token-budget blocker',
      }
    : {
        diagnosticMessage: 'Accepted explicit project planner retry after clearing stale blocked planning metadata.',
        intentReason: 'explicit start_project retry for planner blocker',
      };
}
