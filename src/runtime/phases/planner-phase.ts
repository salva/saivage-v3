import type { CardRecord, RuntimeState } from '../../schemas/index.js';
import type { PlannerResult } from '../../contracts/index.js';
import { STARTABLE_STATES, RESTARTABLE_STATES } from '../../permissions/index.js';
import { blockedPlanningReason, getBlockedPlanning, isReviewerCapacityPlannerBlocker, shouldPreservePrecisePlanningBlocker } from '../planning-blockers.js';
import { activeRunFromActivationState, plannerActivationStateFromGoal } from '../activation-reducer.js';
import { lifecyclePatch } from '../terminal-commit/lifecycle-patch.js';

export type GoalActivationTransitionDecision =
  | { kind: 'none' }
  | { kind: 'transition'; action: 'start' | 'restart' }
  | { kind: 'invalid_status' };

export function decideGoalActivationTransition(status: CardRecord['status']): GoalActivationTransitionDecision {
  if (status === 'active' || status === 'running') return { kind: 'none' };
  if ((STARTABLE_STATES as readonly CardRecord['status'][]).includes(status)) return { kind: 'transition', action: 'start' };
  if ((RESTARTABLE_STATES as readonly CardRecord['status'][]).includes(status)) return { kind: 'transition', action: 'restart' };
  return { kind: 'invalid_status' };
}

export function hasPlannerAction(input: {
  createdCardIds: readonly string[];
  updatedCardIds: readonly string[];
  hasGoalDispatch: boolean;
  hasUnfinishedChildWork: boolean;
  executedTerminal: boolean;
}): boolean {
  return (
    input.createdCardIds.length > 0 ||
    input.updatedCardIds.length > 0 ||
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
}): { currentCard: CardRecord | null; currentPlanning: Record<string, unknown> } | null {
  if (input.plannerResult.status !== 'done') return null;
  const currentPlanning =
    input.currentCard?.result && typeof input.currentCard.result === 'object'
      ? ((input.currentCard.result as Record<string, unknown>).planning as Record<string, unknown> | undefined)
      : undefined;
  return currentPlanning?.status === 'blocked' &&
    currentPlanning.resume_reason === 'planner_context_length_exceeded' &&
    currentPlanning.failure_kind === 'token_budget_exceeded'
    ? { currentCard: input.currentCard ?? null, currentPlanning }
    : null;
}

export function buildPlannerBlockedDecision(input: {
  currentCard: CardRecord | null | undefined;
  plannerBlockedReason: string | null;
  createdCardIds: readonly string[];
  updatedCardIds: readonly string[];
}): { blockedReason: string | null; planning: Record<string, unknown>; terminalReason: string } {
  const preservePreciseBlocker = shouldPreservePrecisePlanningBlocker(input.currentCard ?? null, 'planner_blocked');
  const currentResult =
    input.currentCard?.result && typeof input.currentCard.result === 'object'
      ? (input.currentCard.result as Record<string, unknown>)
      : {};
  const preservedPlanning = preservePreciseBlocker ? (currentResult.planning as Record<string, unknown>) : null;
  const reviewerCapacityPlannerBlocker = isReviewerCapacityPlannerBlocker(input.plannerBlockedReason);
  const blockedReason = preservePreciseBlocker
    ? typeof preservedPlanning?.blocked_reason === 'string'
      ? preservedPlanning.blocked_reason
      : (input.currentCard?.error ?? input.currentCard?.status_text ?? input.plannerBlockedReason)
    : input.plannerBlockedReason;
  if (preservePreciseBlocker) {
    return {
      blockedReason,
      planning: {
        ...preservedPlanning,
        status: 'blocked',
        blocked_reason: blockedReason,
        resume_reason: 'reviewer_unavailable',
        failure_kind: 'reviewer_invocation_failed',
        created_cards: input.createdCardIds,
        updated_cards: input.updatedCardIds,
        preserved_from_generic_planner_blocked: true,
        generic_planner_blocked_reason: input.plannerBlockedReason,
      },
      terminalReason: 'reviewer_invocation_failed',
    };
  }
  if (reviewerCapacityPlannerBlocker) {
    return {
      blockedReason,
      planning: {
        status: 'blocked',
        blocked_reason: blockedReason,
        resume_reason: 'reviewer_unavailable',
        failure_kind: 'reviewer_invocation_failed',
        inferred_from_planner_blocked_reason: true,
        created_cards: input.createdCardIds,
        updated_cards: input.updatedCardIds,
      },
      terminalReason: 'reviewer_invocation_failed',
    };
  }
  return {
    blockedReason,
    planning: {
      status: 'blocked',
      blocked_reason: input.plannerBlockedReason,
      resume_reason: 'planner_blocked',
      created_cards: input.createdCardIds,
      updated_cards: input.updatedCardIds,
    },
    terminalReason: 'planner_blocked',
  };
}

export function buildPlannerInvocationFailureBlocker(input: {
  tokenBudgetFailure: boolean;
  providerStatus: number | null;
}): { blockedReason: string; resumeReason: string; failureKind: string; planning: Record<string, unknown> } {
  const blockedReason = input.tokenBudgetFailure
    ? 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.'
    : 'Planner did not emit a terminal scheduler tool within the allowed repair turns; operator or runtime repair must restore a contract-valid planner response before continuing backlog promotion.';
  const resumeReason = input.tokenBudgetFailure
    ? 'planner_context_length_exceeded'
    : 'planner_terminal_tool_exhausted';
  const failureKind = input.tokenBudgetFailure
    ? 'token_budget_exceeded'
    : 'planner_contract_terminal_tool_exhausted';
  return {
    blockedReason,
    resumeReason,
    failureKind,
    planning: {
      status: 'blocked',
      blocked_reason: blockedReason,
      resume_reason: resumeReason,
      failure_kind: failureKind,
      provider_status: input.tokenBudgetFailure ? input.providerStatus : null,
      created_cards: [],
      updated_cards: [],
      summary: input.tokenBudgetFailure
        ? 'Planner LLM invocation failed with a context-length/token-budget error before returning scheduler output.'
        : 'Planner LLM invocation exhausted contract repair turns before returning a terminal scheduler tool.',
    },
  };
}

export function buildPlannerContinuePatch(input: {
  existingResult: CardRecord['result'] | undefined;
  plannerDeclaredDone: boolean;
  hasUnfinishedChildWork: boolean;
  hasGoalDispatch: boolean;
  createdCardIds: readonly string[];
  updatedCardIds: readonly string[];
}): Partial<CardRecord> {
  void input;
  return {};
}

export type PlannerPostDispatchDecision =
  | { kind: 'block'; blockedReason: string; planning: Record<string, unknown>; terminalReason: string }
  | { kind: 'continue'; patch: Partial<CardRecord> }
  | { kind: 'exit_with_unfinished_child_work'; patch: Partial<CardRecord>; terminalReason: string }
  | { kind: 'ready_for_review' };

export function decidePlannerPostDispatch(input: {
  plannerResult: PlannerResult;
  currentCard: CardRecord | null | undefined;
  createdCardIds: readonly string[];
  updatedCardIds: readonly string[];
  hasGoalDispatch: boolean;
  hasUnfinishedChildWork: boolean;
  executedTerminal: boolean;
  isProjectCard: boolean;
}): PlannerPostDispatchDecision {
  if (input.plannerResult.status === 'blocked') {
    const decision = buildPlannerBlockedDecision({
      currentCard: input.currentCard,
      plannerBlockedReason: input.plannerResult.blocked_reason ?? null,
      createdCardIds: input.createdCardIds,
      updatedCardIds: input.updatedCardIds,
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
    createdCardIds: input.createdCardIds,
    updatedCardIds: input.updatedCardIds,
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
        status: 'blocked',
        blocked_reason: blockedReason,
        planner_declared_done: false,
        has_unfinished_child_work: false,
        resume_reason: 'non_actionable_continue',
        created_cards: [],
        updated_cards: [],
        summary: input.plannerResult.summary ?? null,
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
        status: 'blocked',
        blocked_reason: blockedReason,
        planner_declared_done: true,
        has_unfinished_child_work: false,
        resume_reason: 'non_actionable_project_done',
        created_cards: [],
        updated_cards: [],
        summary: input.plannerResult.summary ?? null,
      },
      terminalReason: 'planner_non_actionable_project_done',
    };
  }

  if (input.plannerResult.status === 'done' && !input.hasGoalDispatch && !input.hasUnfinishedChildWork) {
    return { kind: 'ready_for_review' };
  }

  const patch = buildPlannerContinuePatch({
    existingResult: input.currentCard?.result,
    plannerDeclaredDone: input.plannerResult.status === 'done',
    hasUnfinishedChildWork: input.hasUnfinishedChildWork,
    hasGoalDispatch: input.hasGoalDispatch,
    createdCardIds: input.createdCardIds,
    updatedCardIds: input.updatedCardIds,
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
  createdCardIds: string[];
  updatedCardIds: string[];
  hasUnfinishedChildWork: boolean;
} {
  return {
    createdCardIds: (input.plannerResult.created_cards ?? [])
      .map((card) => card.id)
      .filter((id): id is string => Boolean(id)),
    updatedCardIds: (input.plannerResult.updated_cards ?? [])
      .map((card) => card.id)
      .filter((id): id is string => Boolean(id)),
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
    current_card_id: input.goal.id,
    current_agent_session_id: input.plannerSessionId,
    active_card_run: activeRun,
  };
}

export interface PlannerActivationSetup {
  plannerSessionId: string;
  existingResult: Record<string, unknown>;
  existingPlanning: Record<string, unknown> | null;
  retryingTokenBudgetBlocker: boolean;
  retryingTerminalToolBlocker: boolean;
  retryingPlanningBlocker: boolean;
  shouldCompactPersistedPlannerHistory: boolean;
  shouldUpdatePlanning: boolean;
}

export function planPlannerActivationSetup(input: {
  goalId: string;
  initialStatus: CardRecord['status'];
  refreshedCard: CardRecord;
}): PlannerActivationSetup {
  const existingResult =
    input.refreshedCard.result && typeof input.refreshedCard.result === 'object'
      ? (input.refreshedCard.result as Record<string, unknown>)
      : {};
  const existingPlanning =
    existingResult.planning && typeof existingResult.planning === 'object'
      ? (existingResult.planning as Record<string, unknown>)
      : null;
  const hasTokenBudgetPlanningBlocker =
    existingPlanning?.status === 'blocked' &&
    existingPlanning.resume_reason === 'planner_context_length_exceeded' &&
    existingPlanning.failure_kind === 'token_budget_exceeded';
  const hasTerminalToolPlanningBlocker =
    existingPlanning?.status === 'blocked' &&
    existingPlanning.resume_reason === 'planner_terminal_tool_exhausted' &&
    existingPlanning.failure_kind === 'planner_contract_terminal_tool_exhausted';
  const retryingTokenBudgetBlocker =
    input.initialStatus !== 'active' &&
    input.initialStatus !== 'running' &&
    hasTokenBudgetPlanningBlocker;
  const retryingTerminalToolBlocker =
    input.initialStatus !== 'active' &&
    input.initialStatus !== 'running' &&
    hasTerminalToolPlanningBlocker;
  const retryingPlanningBlocker = retryingTokenBudgetBlocker || retryingTerminalToolBlocker;
  return {
    plannerSessionId: `planner:${input.goalId}`,
    existingResult,
    existingPlanning,
    retryingTokenBudgetBlocker,
    retryingTerminalToolBlocker,
    retryingPlanningBlocker,
    shouldCompactPersistedPlannerHistory: retryingTokenBudgetBlocker || existingPlanning === null,
    shouldUpdatePlanning: existingPlanning === null || retryingPlanningBlocker,
  };
}

export function buildPlannerActivationPlanningPatch(input: {
  existingResult: Record<string, unknown>;
  existingError: string | null | undefined;
  existingStatusText: string | null | undefined;
  retryingTokenBudgetBlocker: boolean;
  retryingTerminalToolBlocker: boolean;
  compactedPersistedPlannerHistory: boolean;
}): Partial<CardRecord> {
  const retryingPlanningBlocker = input.retryingTokenBudgetBlocker || input.retryingTerminalToolBlocker;
  return {
    status_text: retryingPlanningBlocker ? null : input.existingStatusText,
  };
}

export function buildProjectPlannerRetryPatch(input: {
  existingResult: CardRecord['result'] | undefined;
  retryingTokenBudgetBlocker: boolean;
  compactedPersistedPlannerHistory: boolean;
}): Partial<CardRecord> {
  void input;
  return {
    ...lifecyclePatch({ status: 'active', result: null, error: null, completed_at: null }),
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
        diagnosticMessage: 'Accepted explicit retry for project planner terminal-tool exhaustion blocker after clearing stale blocked planning metadata.',
        intentReason: 'explicit start_project retry for planner terminal-tool exhaustion blocker',
      };
}
