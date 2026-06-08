import type { AgentExecutionPort } from '../contracts/index.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { SessionStamper } from './session-stamper.js';
import type { RuntimeConfig, RuntimeSkillsPort } from './runtime-config.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import { readRuntimeState } from './state.js';
import type { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import type { RuntimeReviewerDispatcher } from './runtime-reviewer-dispatcher.js';
import { buildDispatchPausedRuntimeStatePatch } from './runtime-core.js';
import type { RuntimeServices } from './runtime-services.js';
import { PlannerActivationRunner } from './phases/planner-activation-runner.js';
import { PlannerIterationRunner } from './phases/planner-iteration-runner.js';
import { PlannerFailureHandler } from './phases/planner-failure-handler.js';
import { commitPlannerBlocked } from './terminal-commit/index.js';

const MAX_PLANNER_ITERATIONS = 50;

export interface RuntimePlannerDispatcherDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'cards'
  | 'eventLogger'
  | 'errorLogger'
  | 'stateMachine'
  | 'mutations'
  | 'lifecycle'
  | 'emit'
  | 'publishRuntimeDiagnostic'
  | 'now'
> {
  agentRuntime: AgentExecutionPort;
  skillsEngine(): RuntimeSkillsPort | null;
  goalContext: RuntimeGoalContextCoordinator;
  pendingActivations: PendingActivationDispatcher;
  reviewerDispatcher: RuntimeReviewerDispatcher;
  runLedger: RuntimeRunLedger;
  sessionStamper: SessionStamper;
  goalDispatcher: RuntimeConfig['goalDispatcher'];
  plannerFailureHandler: PlannerFailureHandler;
}

export class RuntimePlannerDispatcher {
  constructor(private readonly deps: RuntimePlannerDispatcherDeps) {}

  async dispatchGoal(goalId: string): Promise<void> {
    return this.deps.goalDispatcher
      ? this.deps.goalDispatcher(goalId, (nextGoalId) => this.dispatchGoalInternal(nextGoalId))
      : this.dispatchGoalInternal(goalId);
  }

  private async dispatchGoalInternal(goalId: string): Promise<void> {
    const existing = this.deps.lifecycle.dispatchPromises.get(goalId);
    if (existing) return existing;
    const dispatch = this.runPlannerLoop(goalId).finally(() => {
      this.deps.lifecycle.dispatchInFlight.delete(goalId);
      this.deps.lifecycle.dispatchPromises.delete(goalId);
    });
    this.deps.lifecycle.dispatchInFlight.add(goalId);
    this.deps.lifecycle.dispatchPromises.set(goalId, dispatch);
    return dispatch;
  }

  private async runPlannerLoop(goalId: string): Promise<void> {
    if (this.deps.lifecycle.paused) {
      this.emitDispatchBlocked(goalId);
      return;
    }
    this.ensureDirectPlannerRun(goalId);
    try {
      await this.plannerActivationRunner().activate(goalId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.publishRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
      this.deps.errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' });
      return;
    }
    let plannerDone = false;
    let sawReplan = false;
    for (let iter = 0; iter < MAX_PLANNER_ITERATIONS && !plannerDone && !this.deps.lifecycle.shuttingDown; iter++) {
      if (this.deps.lifecycle.paused) {
        this.emitDispatchBlocked(goalId);
        this.deps.mutations.apply({ kind: 'patchRuntimeState', patch: buildDispatchPausedRuntimeStatePatch() });
        return;
      }
      const iteration = await this.plannerIterationRunner(goalId).run({ goalId, iteration: iter });
      if (iteration.kind === 'planner_failure_handled' || iteration.kind === 'post_dispatch_return') return;
      if (iteration.kind === 'shutdown') break;
      if (iteration.kind === 'paused') {
        this.emitDispatchBlocked(goalId);
        return;
      }
      if (iteration.kind === 'replan') {
        sawReplan = true;
        this.emitReplan(goalId, iter);
        try {
          await this.plannerActivationRunner().activate(goalId);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.deps.publishRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
          this.deps.errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' });
          return;
        }
        continue;
      }
      plannerDone = iteration.plannerDone;
      if (plannerDone) {
        const completed = await this.deps.reviewerDispatcher.runReviewer(goalId, iteration.planningContext);
        if (completed) return;
        plannerDone = false;
        try {
          await this.plannerActivationRunner().activate(goalId);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.deps.publishRuntimeDiagnostic({ goal_id: goalId, phase: 'review_correction_activate', error: err });
          this.deps.errorLogger.appendError({ message: errorMessage, goalId, phase: 'review_correction_activate' });
          return;
        }
      }
    }
    if (this.deps.lifecycle.shuttingDown) {
      this.deps.emit('dispatch_interrupted', { goal_id: goalId, reason: 'shutdown' });
      this.deps.eventLogger.appendEvent({
        kind: 'dispatch_interrupted',
        goal_id: goalId,
        reason: 'shutdown',
      });
      return;
    }
    if (sawReplan) await this.terminateIfNonTerminal(goalId);
  }

  private ensureDirectPlannerRun(goalId: string): void {
    const card = this.deps.cards.read(goalId);
    if (!card || (card.type !== 'project' && card.type !== 'goal')) return;
    const hasOpenRun = (readRuntimeState(this.deps.projectRoot)?.runtime_runs ?? []).some(
      (run) => run.card_id === goalId && ['pending', 'planner'].includes(run.phase) && run.runtime_status === 'running' && !run.finished_at,
    );
    if (hasOpenRun) return;
    this.deps.mutations.apply({
      kind: 'appendRuntimeRun',
      run: {
        kind: 'root',
        card_id: goalId,
        ownership: { kind: 'direct', source: goalId === PROJECT_CARD_ID ? 'project_root' : 'operator' },
        parent_run_id: null,
        command_id: null,
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: null,
      },
    });
  }

  private plannerActivationRunner(): PlannerActivationRunner {
    return new PlannerActivationRunner({
      projectRoot: this.deps.projectRoot,
      cards: this.deps.cards,
      eventLogger: this.deps.eventLogger,
      stateMachine: this.deps.stateMachine,
      mutations: this.deps.mutations,
      runLedger: this.deps.runLedger,
      sessionStamper: this.deps.sessionStamper,
      now: this.deps.now,
    });
  }

  private plannerIterationRunner(goalId: string): PlannerIterationRunner {
    return new PlannerIterationRunner({
      cards: this.deps.cards,
      agentRuntime: this.deps.agentRuntime,
      skillsEngine: () => this.deps.skillsEngine(),
      stateMachine: this.deps.stateMachine,
      goalContext: this.deps.goalContext,
      pendingActivations: this.deps.pendingActivations,
      mutations: this.deps.mutations,
      runLedger: this.deps.runLedger,
      lifecycle: this.deps.lifecycle,
      now: this.deps.now,
      handlePlannerFailure: (error) => this.deps.plannerFailureHandler.handle(goalId, error),
    });
  }

  private emitDispatchBlocked(goalId: string): void {
    this.deps.emit('dispatch_blocked', { reason: 'paused', goal_id: goalId });
    this.deps.eventLogger.appendEvent({
      kind: 'dispatch_blocked',
      reason: 'paused',
      goal_id: goalId,
    });
  }

  private emitReplan(goalId: string, iter: number): void {
    const message = `replanning changed goal at planner iteration ${iter}`;
    this.deps.publishRuntimeDiagnostic({ goal_id: goalId, phase: 'replan', error: new Error(message) });
  }

  private async terminateIfNonTerminal(goalId: string): Promise<void> {
    const card = this.deps.cards.read(goalId);
    if (!card) return;
    if (card.status === 'done' || card.status === 'failed' || card.status === 'blocked' || card.status === 'cancelled') return;
    const reason = `goal '${goalId}' did not pass review within the planner iteration budget`;
    await commitPlannerBlocked({
      card,
      blockedReason: reason,
      resumeReason: reason,
      effects: {
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event as 'block', details),
        updateCard: (cardId, patch) => this.deps.cards.commitTerminalLifecyclePatch(cardId, patch),
      },
    });
    this.deps.runLedger.finishOpenPlannerRun(goalId, 'blocked');
    await this.deps.stateMachine.transition('card_terminated', { goalId, reason });
  }
}
