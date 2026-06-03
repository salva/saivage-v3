import type { AgentExecutionPort, PlannerResult } from '../../contracts/index.js';
import type { CardStore } from '../../cards/store-api.js';
import { PROJECT_CARD_ID } from '../../cards/store-api.js';
import type { RuntimeSkillsPort } from '../runtime-config.js';
import type { RuntimeGoalContextCoordinator } from '../runtime-goal-context.js';
import type { PendingActivationDispatcher } from '../pending-activation-dispatcher.js';
import type { RuntimeRunLedger } from '../runtime-run-ledger.js';
import type { RuntimeStateMachine } from '../state-machine.js';
import type { RuntimeStateMutationPort } from '../mutations.js';
import type { RuntimeLifecycleState } from '../runtime-lifecycle-state.js';
import { buildGoalEvidenceContext } from '../context-builder.js';
import { buildCurrentAgentSessionPatch } from '../runtime-core.js';
import { decidePlannerPostDispatch, summarizePlannerPostDispatch } from './planner-phase.js';
import { handlePlannerPostDispatchDecision } from './planner-post-dispatch-handler.js';
import { PlannerPhaseRunner } from './planner-phase-runner.js';
import { PlannerResultApplier } from './planner-result-applier.js';

export type PlannerIterationResult =
  | { kind: 'continue'; plannerDone: boolean }
  | { kind: 'planner_failure_handled' }
  | { kind: 'post_dispatch_return' }
  | { kind: 'paused' }
  | { kind: 'shutdown' };

export interface PlannerIterationRunnerDeps {
  cards: CardStore;
  agentRuntime: AgentExecutionPort;
  skillsEngine(): RuntimeSkillsPort | null;
  stateMachine: RuntimeStateMachine;
  goalContext: RuntimeGoalContextCoordinator;
  pendingActivations: PendingActivationDispatcher;
  mutations: RuntimeStateMutationPort;
  runLedger: RuntimeRunLedger;
  lifecycle: RuntimeLifecycleState;
  handlePlannerFailure(error: unknown): Promise<{ kind: 'handled' } | { kind: 'rethrow'; error: unknown }>;
}

export class PlannerIterationRunner {
  constructor(private readonly deps: PlannerIterationRunnerDeps) {}

  async run(input: { goalId: string; iteration: number }): Promise<PlannerIterationResult> {
    const { goalId, iteration } = input;
    let plannerResult: PlannerResult;
    try {
      plannerResult = await new PlannerPhaseRunner({
        agentRuntime: this.deps.agentRuntime,
        skillsEngine: this.deps.skillsEngine(),
        maxDepth: this.deps.cards.maxDepth,
        readGoalCard: (cardId) => this.deps.cards.read(cardId),
        buildGoalEvidenceContext: (cardId) => buildGoalEvidenceContext({ goalId: cardId, cards: this.deps.cards }),
        buildGoalContextBlock: (cardId, resumeReason) => this.deps.goalContext.buildGoalContextBlock(cardId, resumeReason),
        inferResumeReason: (cardId, fallback) => this.deps.goalContext.inferResumeReason(cardId, fallback),
        consumeResumeHandoffContext: () => this.deps.lifecycle.consumeResumeHandoffContext(),
        injectSyntheticPlannerNotes: (cardId) => {
          this.deps.goalContext.injectQueuedPlannerNotes(`planner:${cardId}`);
        },
      }).run({ goalId, iteration });
    } catch (err) {
      const failure = await this.deps.handlePlannerFailure(err);
      if (failure.kind === 'handled') return { kind: 'planner_failure_handled' };
      throw failure.error;
    }

    await new PlannerResultApplier({
      cardStore: this.deps.cards,
      transitionCard: (cardId, action, details) => this.deps.stateMachine.transitionCard(cardId, action, details),
    }).apply(goalId, plannerResult);
    this.deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildCurrentAgentSessionPatch(`planner:${goalId}`) });
    const execution = await this.deps.pendingActivations.dispatch(goalId);
    if (this.deps.lifecycle.isShuttingDown()) return { kind: 'shutdown' };
    if (this.deps.lifecycle.isPaused()) return { kind: 'paused' };

    const postDispatchSummary = summarizePlannerPostDispatch({ plannerResult, childCards: this.deps.cards.list(), goalId });
    const postDispatchDecision = decidePlannerPostDispatch({
      plannerResult,
      currentCard: this.deps.cards.read(goalId),
      createdCardIds: postDispatchSummary.createdCardIds,
      updatedCardIds: postDispatchSummary.updatedCardIds,
      hasGoalDispatch: execution.dispatchedGoal,
      hasUnfinishedChildWork: postDispatchSummary.hasUnfinishedChildWork,
      executedTerminal: execution.executedTerminal,
      isProjectCard: goalId === PROJECT_CARD_ID,
    });
    const postDispatch = await handlePlannerPostDispatchDecision({
      goalId,
      decision: postDispatchDecision,
      effects: {
        blockGoalWithPlanning: (block) => this.blockGoalWithPlanning(block),
        updateGoalCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
        transitionGoalExit: (cardId, reason) => this.deps.stateMachine.transition('goal_exit', { goalId: cardId, reason }),
      },
    });
    if (postDispatch.shouldReturn) return { kind: 'post_dispatch_return' };
    return { kind: 'continue', plannerDone: postDispatch.plannerDone };
  }

  private async blockGoalWithPlanning(input: {
    goalId: string;
    blockedReason: string;
    planning: Record<string, unknown>;
    terminalReason: string;
  }): Promise<void> {
    await this.deps.stateMachine.transitionCard(input.goalId, 'block', {
      blocked_reason: input.blockedReason,
    });
    await this.deps.cards.update(input.goalId, {
      status: 'blocked',
      error: input.blockedReason,
      status_text: input.blockedReason,
      result: {
        ...(this.deps.cards.read(input.goalId)?.result ?? {}),
        planning: input.planning,
      },
    });
    this.deps.runLedger.finishOpenPlannerRun(input.goalId, 'blocked');
    await this.deps.stateMachine.transition('card_terminated', {
      goalId: input.goalId,
      reason: input.terminalReason,
    });
  }
}
