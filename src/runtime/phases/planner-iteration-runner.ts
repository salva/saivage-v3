import type { AgentExecutionPort, PlannerResult } from '../../contracts/index.js';
import type { PlannerActivationBarrierRequest } from '../../contracts/index.js';
import type { PlannerDoneResult } from '../../schemas/index.js';
import { PROJECT_CARD_ID } from '../../cards/store-api.js';
import type { RuntimeSkillsPort } from '../runtime-config.js';
import type { RuntimeGoalContextCoordinator } from '../runtime-goal-context.js';
import type { PendingActivationDispatcher } from '../pending-activation-dispatcher.js';
import type { RuntimeRunLedger } from '../runtime-run-ledger.js';
import type { RuntimeServices } from '../runtime-services.js';
import { buildGoalEvidenceContext } from '../context-builder.js';
import { buildCurrentAgentSessionPatch } from '../runtime-core.js';
import { decidePlannerPostDispatch, summarizePlannerPostDispatch } from './planner-phase.js';
import { handlePlannerPostDispatchDecision } from './planner-post-dispatch-handler.js';
import { PlannerPhaseRunner } from './planner-phase-runner.js';
import { commitPlannerBlocked } from '../terminal-commit/index.js';

export type PlannerIterationResult =
  | { kind: 'continue'; plannerDone: boolean; planningContext: PlannerDoneResult | null }
  | { kind: 'replan' }
  | { kind: 'planner_failure_handled' }
  | { kind: 'post_dispatch_return' }
  | { kind: 'paused' }
  | { kind: 'shutdown' };

export interface PlannerIterationRunnerDeps extends Pick<RuntimeServices,
  | 'cards'
  | 'stateMachine'
  | 'mutations'
  | 'lifecycle'
  | 'now'
> {
  agentRuntime: AgentExecutionPort;
  skillsEngine(): RuntimeSkillsPort | null;
  goalContext: RuntimeGoalContextCoordinator;
  pendingActivations: PendingActivationDispatcher;
  runLedger: RuntimeRunLedger;
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
        injectSyntheticPlannerNotes: (cardId) => {
          this.deps.goalContext.injectQueuedPlannerNotes(`planner:${cardId}`);
        },
        activationBarrier: {
          dispatch: async ({ activation }: PlannerActivationBarrierRequest) => {
            await this.deps.pendingActivations.dispatchActivation(activation);
          },
        },
      }).run({ goalId, iteration });
    } catch (err) {
      const failure = await this.deps.handlePlannerFailure(err);
      if (failure.kind === 'handled') return { kind: 'planner_failure_handled' };
      throw failure.error;
    }

    this.deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildCurrentAgentSessionPatch(`planner:${goalId}`) });
    const execution = await this.deps.pendingActivations.dispatch(goalId);
    if (this.deps.lifecycle.shuttingDown) return { kind: 'shutdown' };
    if (this.deps.lifecycle.paused) return { kind: 'paused' };
    if (this.deps.cards.read(goalId)?.status === 'changed') return { kind: 'replan' };

    const postDispatchSummary = summarizePlannerPostDispatch({ plannerResult, childCards: this.deps.cards.list(), goalId });
    const postDispatchDecision = decidePlannerPostDispatch({
      plannerResult,
      currentCard: this.deps.cards.read(goalId),
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
    return {
      kind: 'continue',
      plannerDone: postDispatch.plannerDone,
      planningContext: postDispatch.plannerDone ? plannerDoneContext(plannerResult) : null,
    };
  }

  private async blockGoalWithPlanning(input: {
    goalId: string;
    blockedReason: string;
    planning: Record<string, unknown>;
    terminalReason: string;
  }): Promise<void> {
    const card = this.deps.cards.read(input.goalId);
    if (!card) throw new Error(`Cannot block missing planner goal '${input.goalId}'.`);
    await commitPlannerBlocked({
      card,
      blockedReason: input.blockedReason,
      resumeReason: input.terminalReason,
      effects: {
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event as 'block', details),
        updateCard: (cardId, patch) => this.deps.cards.commitTerminalLifecyclePatch(cardId, patch),
      },
    });
    this.deps.runLedger.finishOpenPlannerRun(input.goalId, 'blocked');
    await this.deps.stateMachine.transition('card_terminated', {
      goalId: input.goalId,
      reason: input.terminalReason,
    });
  }
}

function plannerDoneContext(plannerResult: PlannerResult): PlannerDoneResult {
  return {
    kind: 'planner_done',
    summary: plannerResult.summary ?? 'Planner marked goal done.',
  };
}
