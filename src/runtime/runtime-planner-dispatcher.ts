import type { AgentExecutionPort } from '../contracts/index.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeSkillsPort } from './runtime-config.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { RuntimeGoalContextCoordinator } from './runtime-goal-context.js';
import type { RuntimeRunLedger } from './runtime-run-ledger.js';
import type { PendingActivationDispatcher } from './pending-activation-dispatcher.js';
import type { RuntimeReviewerDispatcher } from './runtime-reviewer-dispatcher.js';
import { buildDispatchPausedRuntimeStatePatch } from './runtime-core.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import { PlannerActivationRunner } from './phases/planner-activation-runner.js';
import { PlannerIterationRunner } from './phases/planner-iteration-runner.js';
import { PlannerFailureHandler } from './phases/planner-failure-handler.js';

const MAX_PLANNER_ITERATIONS = 50;

export interface RuntimePlannerDispatcherDeps {
  projectRoot: string;
  cards: CardStore;
  agentRuntime: AgentExecutionPort;
  skillsEngine(): RuntimeSkillsPort | null;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  stateMachine: RuntimeStateMachine;
  goalContext: RuntimeGoalContextCoordinator;
  pendingActivations: PendingActivationDispatcher;
  reviewerDispatcher: RuntimeReviewerDispatcher;
  mutations: RuntimeStateMutationPort;
  runLedger: RuntimeRunLedger;
  sessionStamper: SessionStamper;
  isPaused(): boolean;
  isShuttingDown(): boolean;
  consumeResumeHandoffContext(): string | null;
  emit(eventName: string, data: Record<string, unknown>): void;
  emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void;
  plannerFailureHandler: PlannerFailureHandler;
  now(): string;
}

export class RuntimePlannerDispatcher {
  constructor(private readonly deps: RuntimePlannerDispatcherDeps) {}

  async dispatchGoal(goalId: string): Promise<void> {
    if (this.deps.isPaused()) {
      this.emitDispatchBlocked(goalId);
      return;
    }
    try {
      await this.plannerActivationRunner().activate(goalId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.emitRuntimeDiagnostic({ goal_id: goalId, phase: 'activate', error: err });
      this.deps.eventLogger.appendEvent({
        kind: 'runtime_diagnostic',
        goal_id: goalId,
        phase: 'activate',
        error_message: errorMessage,
      });
      this.deps.errorLogger.appendError({ message: errorMessage, goalId, phase: 'activate' });
      return;
    }
    let plannerDone = false;
    for (let iter = 0; iter < MAX_PLANNER_ITERATIONS && !plannerDone && !this.deps.isShuttingDown(); iter++) {
      if (this.deps.isPaused()) {
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
      plannerDone = iteration.plannerDone;
      if (plannerDone) {
        const completed = await this.deps.reviewerDispatcher.runReviewer(goalId);
        if (completed) return;
        plannerDone = false;
      }
    }
    if (this.deps.isShuttingDown()) {
      this.deps.emit('dispatch_interrupted', { goal_id: goalId, reason: 'shutdown' });
      this.deps.eventLogger.appendEvent({
        kind: 'dispatch_interrupted',
        goal_id: goalId,
        reason: 'shutdown',
      });
    }
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
      isPaused: () => this.deps.isPaused(),
      isShuttingDown: () => this.deps.isShuttingDown(),
      consumeResumeHandoffContext: () => this.deps.consumeResumeHandoffContext(),
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
}
