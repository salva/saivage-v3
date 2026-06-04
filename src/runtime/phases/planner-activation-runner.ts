import type { CardRecord } from '../../schemas/index.js';
import type { SessionStamper } from '../../contracts/session-stamper.js';
import type { RuntimeRunLedger } from '../runtime-run-ledger.js';
import type { RuntimeServices } from '../runtime-services.js';
import { consumeChangedCardActivation } from '../synthetic-planner-notes.js';
import {
  buildPlannerActivationPlanningPatch,
  buildPlannerActiveRunPatch,
  decideGoalActivationTransition,
  planPlannerActivationSetup,
} from './planner-phase.js';
import { compactPersistedPlannerHistoryForRetry } from '../persisted-planner-history.js';

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
    const activationTransition = decideGoalActivationTransition(currentStatus);
    if (activationTransition.kind === 'invalid_status') {
      throw new Error(`Goal '${goalId}' is in status '${currentStatus}' which is neither startable nor restartable.`);
    }
    if (activationTransition.kind === 'transition') {
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
    if (setup.shouldUpdatePlanning) {
      await this.deps.cards.update(
        goalId,
        buildPlannerActivationPlanningPatch({
          existingResult: setup.existingResult,
          existingError: refreshed.lifecycle.error,
          existingStatusText: refreshed.status_text,
          retryingTokenBudgetBlocker: setup.retryingTokenBudgetBlocker,
          retryingTerminalToolBlocker: setup.retryingTerminalToolBlocker,
          compactedPersistedPlannerHistory,
        }),
      );
    }
    const planCard = this.deps.cards.read(goalId)!;
    this.deps.mutations.apply({
      kind: 'patchRuntimeState',
      patch: buildPlannerActiveRunPatch({ goal: planCard, plannerSessionId: setup.plannerSessionId, at: this.deps.now() }),
    });
    this.deps.runLedger.bindPlannerSessionToOpenRun(goalId, setup.plannerSessionId);
    return planCard;
  }
}
