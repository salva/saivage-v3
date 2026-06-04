import type { ActivationCompletionOutcome, CardRecord } from '../schemas/index.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import {
  selectChildGoalActivationOutcome,
  selectPendingActivationChildCardIds,
} from './activation-unwind.js';
import { readRuntimeState } from './state.js';
import { ExecutorActivationDispatcher } from './executor-activation-dispatcher.js';
import type { RuntimeServices } from './runtime-services.js';

export interface ChildGoalActivationHandoffEffects {
  dispatchGoal(goalId: string): Promise<void>;
  readCard(cardId: string): Pick<CardRecord, 'status'> | null;
  appendChildUnwindToolResult(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): void;
}

export interface ChildGoalActivationHandoffResult {
  outcome: ActivationCompletionOutcome;
  completedSuccessfully: boolean;
}

export async function deliverChildGoalActivationHandoff(input: {
  childCardId: string;
  effects: ChildGoalActivationHandoffEffects;
}): Promise<ChildGoalActivationHandoffResult> {
  await input.effects.dispatchGoal(input.childCardId);
  const completedCard = input.effects.readCard(input.childCardId);
  const outcome = selectChildGoalActivationOutcome(completedCard);
  input.effects.appendChildUnwindToolResult(
    input.childCardId,
    outcome,
    `Child goal ${input.childCardId} finished with status ${completedCard?.status ?? 'unknown'}.`,
  );
  return { outcome, completedSuccessfully: outcome === 'done' };
}

interface PendingActivationDispatcherDeps extends Pick<RuntimeServices, 'projectRoot' | 'cards' | 'lifecycle'> {
  activationUnwind: ActivationUnwindRunner;
  dispatchGoalThroughScheduler(goalId: string): Promise<void>;
  executorActivations: ExecutorActivationDispatcher;
}

export class PendingActivationDispatcher {
  constructor(private readonly deps: PendingActivationDispatcherDeps) {}

  async dispatch(goalId: string): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    let activationCards = this.getPendingActivationCards(goalId);
    const goalCard = this.deps.cards.read(goalId);
    let dispatchedGoal = false;
    let executedTerminal = false;
    let failed = false;
    while (activationCards.length > 0 && !this.deps.lifecycle.shuttingDown) {
      if (this.deps.lifecycle.paused) return { dispatchedGoal, executedTerminal, failed };
      for (const card of activationCards) {
        if (this.deps.lifecycle.shuttingDown || this.deps.lifecycle.paused) return { dispatchedGoal, executedTerminal, failed };
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
