import type { CardRecord } from '../../schemas/index.js';
import type { SessionStamper } from '../session-stamper.js';
import type { RuntimeRunLedger } from '../runtime-run-ledger.js';
import type { RuntimeServices } from '../runtime-services.js';
import { consumeChangedCardActivation } from '../synthetic-planner-notes.js';
import {
  buildPlannerActivationPlanningPatch,
  buildPlannerActiveRunPatch,
  planPlannerActivationSetup,
} from './planner-phase.js';
import { compactPersistedPlannerHistoryForRetry } from '../persisted-planner-history.js';
import { readRuntimeState } from '../state.js';
import { selectActivationStartAction } from '../transition-policy.js';

export interface PlannerActivationRunnerDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'cards'
  | 'eventLogger'
  | 'stateMachine'
  | 'mutations'
  | 'now'
> {
  runLedger: RuntimeRunLedger;
  sessionStamper: SessionStamper;
}

export class PlannerActivationRunner {
  constructor(private readonly deps: PlannerActivationRunnerDeps) {}

  async activate(goalId: string): Promise<CardRecord> {
    consumeChangedCardActivation(this.deps.projectRoot, goalId);
    const goalCard = this.deps.cards.read(goalId);
    if (!goalCard) throw new Error(`Goal '${goalId}' not found.`);
    if (goalCard.type !== 'project' && goalCard.type !== 'goal') {
      throw new Error(`dispatchGoal requires a project or goal card, got type '${goalCard.type}'.`);
    }
    const currentStatus = goalCard.status;
    const activationTransition = selectActivationStartAction(currentStatus, 'planner');
    if (activationTransition.action === 'reject') {
      throw new Error(`Goal '${goalId}' is in status '${currentStatus}' which is neither startable nor restartable.`);
    }
    if (activationTransition.action === 'start' || activationTransition.action === 'restart') {
      const transitioned = await this.deps.stateMachine.transitionCard(goalId, activationTransition.action, { goalId });
      if (!transitioned) {
        throw new Error(`Goal '${goalId}' could not be transitioned via ${activationTransition.action} from status '${currentStatus}'.`);
      }
    }
    const refreshed = this.deps.cards.read(goalId);
    if (!refreshed) throw new Error(`Goal '${goalId}' disappeared during activation.`);
    const setup = planPlannerActivationSetup({ goalId, initialStatus: currentStatus, refreshedCard: refreshed });
    const compactedPersistedPlannerHistory = setup.shouldCompactPersistedPlannerHistory
      ? compactPersistedPlannerHistoryForRetry({
          projectRoot: this.deps.projectRoot,
          plannerSessionId: setup.plannerSessionId,
          sessionStamper: this.deps.sessionStamper,
          eventLogger: this.deps.eventLogger,
        })
      : false;
    if (setup.shouldUpdatePlanning || currentStatus === 'changed') {
      await this.deps.cards.update(
        goalId,
        {
          ...buildPlannerActivationPlanningPatch({
          existingResult: setup.existingResult,
          existingError: refreshed.lifecycle.error,
          existingStatusText: refreshed.status_text,
          retryingTokenBudgetBlocker: setup.retryingTokenBudgetBlocker,
          compactedPersistedPlannerHistory,
          }),
          ...(currentStatus === 'changed' ? { retries: 0 } : {}),
        },
      );
    }
    const planCard = this.deps.cards.read(goalId);
    if (!planCard) throw new Error(`Card '${goalId}' disappeared after activation update.`);
    const openRun = (readRuntimeState(this.deps.projectRoot)?.runtime_runs ?? []).find((run) => run.card_id === goalId && ['pending', 'planner'].includes(run.phase) && run.runtime_status === 'running' && !run.finished_at);
    if (!openRun) throw new Error(`Planner activation for '${goalId}' has no open runtime run ownership.`);
    if (openRun.session_id && openRun.session_id !== setup.plannerSessionId) throw new Error(`Planner activation for '${goalId}' has contradictory runtime run session identity.`);
    this.deps.mutations.apply({
      kind: 'patchRuntimeState',
      patch: buildPlannerActiveRunPatch({
        goal: planCard,
        ownership: openRun.ownership,
        plannerSessionId: setup.plannerSessionId,
        callerSessionId: openRun.ownership.kind === 'activation' ? openRun.ownership.parent_session_id : null,
        callerToolCallId: openRun.ownership.kind === 'activation' ? openRun.ownership.parent_tool_call_id : null,
        at: this.deps.now(),
      }),
    });
    this.deps.runLedger.bindPlannerSessionToOpenRun(goalId, setup.plannerSessionId);
    return planCard;
  }
}
