import type { CardRecord } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import {
  selectPendingActivationChildCardIds,
} from './activation-unwind.js';
import { deliverChildGoalActivationHandoff } from './activation-handoff.js';
import { readRuntimeState } from './state.js';
import { ExecutorActivationDispatcher } from './executor-activation-dispatcher.js';
import type { RuntimeLifecycleState } from './runtime-lifecycle-state.js';

export class PendingActivationDispatcher {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: CardStore;
      activationUnwind: ActivationUnwindRunner;
      lifecycle: RuntimeLifecycleState;
      dispatchGoalThroughScheduler(goalId: string): Promise<void>;
      executorActivations: ExecutorActivationDispatcher;
    },
  ) {}

  async dispatch(goalId: string): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    let activationCards = this.getPendingActivationCards(goalId);
    const goalCard = this.deps.cards.read(goalId);
    let dispatchedGoal = false;
    let executedTerminal = false;
    let failed = false;
    while (activationCards.length > 0 && !this.deps.lifecycle.isShuttingDown()) {
      if (this.deps.lifecycle.isPaused()) return { dispatchedGoal, executedTerminal, failed };
      for (const card of activationCards) {
        if (this.deps.lifecycle.isShuttingDown() || this.deps.lifecycle.isPaused()) return { dispatchedGoal, executedTerminal, failed };
        const callerEdge = this.deps.activationUnwind.findCallerEdge(card.id);
        if (card.type === 'goal') {
          const handoff = await deliverChildGoalActivationHandoff({
            childCardId: card.id,
            effects: {
              dispatchGoal: (childCardId) => this.deps.dispatchGoalThroughScheduler(childCardId),
              readCard: (childCardId) => this.deps.cards.read(childCardId),
              appendChildUnwindToolResult: (childCardId, outcome, summary) =>
                this.deps.activationUnwind.appendChildUnwindToolResult(childCardId, outcome, summary),
            },
          });
          dispatchedGoal = true;
          if (!handoff.completedSuccessfully) return { dispatchedGoal, executedTerminal, failed };
          continue;
        }
        const terminalDispatch = await this.deps.executorActivations.dispatch({ goalId, goalCard, card, callerEdge });
        executedTerminal = executedTerminal || terminalDispatch.executedTerminal;
        if (terminalDispatch.failed) {
          failed = true;
          return { dispatchedGoal, executedTerminal, failed };
        }
      }
      activationCards = this.getPendingActivationCards(goalId);
    }
    return { dispatchedGoal, executedTerminal, failed };
  }

  private getPendingActivationCards(goalId: string): CardRecord[] {
    return selectPendingActivationChildCardIds(readRuntimeState(this.deps.projectRoot), goalId)
      .map((childCardId) => this.deps.cards.read(childCardId))
      .filter((card): card is CardRecord => Boolean(card));
  }

}
