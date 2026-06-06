import type { ActivationCompletionOutcome, CardRecord, RuntimeActivationRecord } from '../schemas/index.js';
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

interface DispatchOneActivationResult {
  dispatchedGoal: boolean;
  executedTerminal: boolean;
  failed: boolean;
}

export class PendingActivationDispatcher {
  constructor(private readonly deps: PendingActivationDispatcherDeps) {}

  async dispatchActivation(activation: RuntimeActivationRecord): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    if (this.deps.lifecycle.shuttingDown) return { dispatchedGoal: false, executedTerminal: false, failed: true };
    if (this.deps.lifecycle.paused) return { dispatchedGoal: false, executedTerminal: false, failed: false };
    const card = this.deps.cards.read(activation.child_card_id);
    if (!card) return { dispatchedGoal: false, executedTerminal: false, failed: true };
    const goalCard = this.deps.cards.read(activation.parent_card_id);
    const callerEdge = this.deps.activationUnwind.findCallerEdge(card.id);
    return this.dispatchOneActivation({ activation, card, goalCard, callerEdge });
  }

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
        const activation = {
          parent_card_id: goalId,
          child_card_id: card.id,
        } as RuntimeActivationRecord;
        const result = await this.dispatchOneActivation({ activation, card, goalCard, callerEdge });
        dispatchedGoal = dispatchedGoal || result.dispatchedGoal;
        executedTerminal = executedTerminal || result.executedTerminal;
        if (result.failed) {
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

  private async dispatchOneActivation(input: {
    activation: Pick<RuntimeActivationRecord, 'parent_card_id' | 'child_card_id'>;
    card: CardRecord;
    goalCard: CardRecord | null;
    callerEdge: ReturnType<ActivationUnwindRunner['findCallerEdge']>;
  }): Promise<DispatchOneActivationResult> {
    if (input.card.type === 'goal') {
      const handoff = await deliverChildGoalActivationHandoff({
        childCardId: input.card.id,
        effects: {
          dispatchGoal: (childCardId) => this.deps.dispatchGoalThroughScheduler(childCardId),
          readCard: (childCardId) => this.deps.cards.read(childCardId),
          appendChildUnwindToolResult: (childCardId, outcome, summary) =>
            this.deps.activationUnwind.appendChildUnwindToolResult(childCardId, outcome, summary),
        },
      });
      return { dispatchedGoal: true, executedTerminal: false, failed: !handoff.completedSuccessfully };
    }
    const terminalDispatch = await this.deps.executorActivations.dispatch({
      goalId: input.activation.parent_card_id,
      goalCard: input.goalCard,
      card: input.card,
      callerEdge: input.callerEdge,
    });
    return { dispatchedGoal: false, executedTerminal: terminalDispatch.executedTerminal, failed: terminalDispatch.failed };
  }

}
