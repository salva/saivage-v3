import type { AgentExecutionPort } from '../contracts/index.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type {
  ActionableErrorEnvelope,
  RuntimeCommandRecord,
  RuntimeRunRecord,
  RuntimeState,
} from '../schemas/index.js';
import type { RuntimeApi } from './runtime-api.js';
import type { SessionStamper } from '../contracts/session-stamper.js';
import { initRuntimeState, readRuntimeState } from './state.js';
import {
  buildCompletedRuntimeCommandState,
  buildRejectedRuntimeCommandState,
  planOpenRootRunStopUpdates,
  planRootRunDispatchFailureUpdate,
  planRootRunDispatchSuccessUpdate,
  planStartProjectPrecondition,
} from './runtime-core.js';
import { cardHasBlockedPlanning, getBlockedPlanning } from './planning-blockers.js';
import {
  buildProjectPlannerRetryPatch,
  describeProjectPlannerRetry,
} from './phases/planner-phase.js';
import { compactPersistedPlannerHistoryForRetry } from './persisted-planner-history.js';
import type { RuntimeServices } from './runtime-services.js';

type RuntimeCommandSource = Parameters<RuntimeApi['startProject']>[0];

export class RuntimeProjectCommandRunner {
  constructor(
    private readonly deps: Pick<RuntimeServices,
      | 'projectRoot'
      | 'cards'
      | 'eventLogger'
      | 'stateMachine'
      | 'mutations'
      | 'lifecycle'
      | 'now'
    > & {
      agentRuntime: AgentExecutionPort;
      sessionStamper: SessionStamper;
      publishRuntimeCommand(command: RuntimeCommandRecord): void;
      publishRuntimeRun(run: RuntimeRunRecord): void;
      publishActionableError(error: ActionableErrorEnvelope): void;
      trackBackgroundDispatch(dispatch: Promise<void>): void;
      dispatchGoalThroughScheduler(goalId: string): Promise<void>;
    },
  ) {}

  async startProject(source: RuntimeCommandSource = 'operator'): Promise<
    | {
        success: true;
        command: RuntimeCommandRecord;
        intent: RuntimeState['runtime_intent'];
        run: RuntimeRunRecord;
      }
    | { success: false; command: RuntimeCommandRecord; error: ActionableErrorEnvelope }
  > {
    const command = this.deps.mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source });
    const state = readRuntimeState(this.deps.projectRoot) ?? initRuntimeState(this.deps.projectRoot);
    const projectCard = this.deps.cards.read(PROJECT_CARD_ID);
    const blockedPlanning = getBlockedPlanning(projectCard);
    const startDecision = planStartProjectPrecondition({
      state,
      projectCardId: PROJECT_CARD_ID,
      projectCardExists: projectCard !== null,
      projectCardStatus: projectCard?.status ?? null,
      hasBlockedPlanning: cardHasBlockedPlanning(projectCard),
      blockedPlanning,
      paused: this.deps.lifecycle.paused,
      source,
    });
    if (startDecision.error) {
      const error = startDecision.error;
      const rejectedAt = this.deps.now();
      const rejection = buildRejectedRuntimeCommandState({ state, command, error, at: rejectedAt });
      const rejectedCommand = rejection.rejectedCommand;
      this.deps.mutations.apply({ kind: 'replaceRuntimeState', state: rejection.state });
      this.deps.publishRuntimeCommand(rejectedCommand);
      this.deps.publishActionableError(error);
      return { success: false, command: rejectedCommand, error };
    }

    const { retryingPlanningBlocker, retryingTokenBudgetPlanningBlocker } = startDecision;
    if (retryingPlanningBlocker) {
      const retryDescription = describeProjectPlannerRetry({ retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker });
      await this.deps.cards.repairTerminalLifecycle(
        PROJECT_CARD_ID,
        buildProjectPlannerRetryPatch({
          existingLifecycle: projectCard?.lifecycle,
          retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker,
          compactedPersistedPlannerHistory: retryingTokenBudgetPlanningBlocker
            ? compactPersistedPlannerHistoryForRetry({
                projectRoot: this.deps.projectRoot,
                plannerSessionId: `planner:${PROJECT_CARD_ID}`,
                sessionStamper: this.deps.sessionStamper,
                eventLogger: this.deps.eventLogger,
              })
            : false,
        }),
      );
      this.deps.eventLogger.appendEvent({
        kind: 'runtime_diagnostic',
        goal_id: PROJECT_CARD_ID,
        phase: 'planner_blocked_retry',
        error_message: retryDescription.diagnosticMessage,
      });
    }
    const retryDescription = retryingPlanningBlocker
      ? describeProjectPlannerRetry({ retryingTokenBudgetBlocker: retryingTokenBudgetPlanningBlocker })
      : null;
    this.deps.mutations.apply({
      kind: 'upsertRuntimeIntent',
      status: 'running',
      sourceCommandId: command.command_id,
      reason: retryDescription?.intentReason ?? 'explicit start_project command',
    });
    let run = this.deps.mutations.apply({
      kind: 'appendRuntimeRun',
      run: {
        kind: 'root',
        card_id: PROJECT_CARD_ID,
        parent_run_id: null,
        command_id: command.command_id,
        activation_id: null,
        phase: 'planner',
        runtime_status: 'running',
        session_id: null,
      },
    });
    if (!projectCard) {
      const completed = this.deps.mutations.apply({
        kind: 'updateRuntimeRun',
        runId: run.run_id,
        updates: {
          phase: 'completed',
          runtime_status: 'idle',
          finished_at: this.deps.now(),
          outcome: { kind: 'completed', result: 'done', finished_at: this.deps.now() },
        },
      });
      if (completed) run = completed;
    }
    this.deps.publishRuntimeRun(run);
    if (projectCard && !this.deps.lifecycle.paused) {
      this.deps.trackBackgroundDispatch(
        this.deps.dispatchGoalThroughScheduler(PROJECT_CARD_ID)
          .then(() => {
            const plan = planRootRunDispatchSuccessUpdate({ state: readRuntimeState(this.deps.projectRoot), runId: run.run_id, nowIso: this.deps.now() });
            if (!plan) return;
            const updated = this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
            if (updated) this.deps.publishRuntimeRun(updated);
          })
          .catch(async () => {
            try {
              await this.deps.stateMachine.transition('goal_exit', {
                goalId: PROJECT_CARD_ID,
                reason: 'dispatch_failed',
              });
            } catch {
              void 0;
            }
            const plan = planRootRunDispatchFailureUpdate({ state: readRuntimeState(this.deps.projectRoot), runId: run.run_id, nowIso: this.deps.now() });
            if (!plan) return;
            const updated = this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
            if (updated) this.deps.publishRuntimeRun(updated);
          }),
      );
    }
    const current = readRuntimeState(this.deps.projectRoot) ?? state;
    const completedAt = this.deps.now();
    const completion = buildCompletedRuntimeCommandState({ state: current, command, at: completedAt });
    const completedCommand = completion.completedCommand;
    this.deps.mutations.apply({ kind: 'replaceRuntimeState', state: completion.state });
    this.deps.publishRuntimeCommand(completedCommand);
    const persisted = readRuntimeState(this.deps.projectRoot) ?? current;
    return {
      success: true,
      command: completedCommand,
      intent: persisted.runtime_intent,
      run: (persisted.runtime_runs ?? []).find((item) => item.run_id === run.run_id) ?? run,
    };
  }

  async stopProject(source: RuntimeCommandSource = 'operator'): Promise<{
    success: true;
    command: RuntimeCommandRecord;
    intent: RuntimeState['runtime_intent'];
    run?: RuntimeRunRecord;
  }> {
    const command = this.deps.mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'stop_project', source });
    this.deps.lifecycle.shuttingDown = true;
    const state = this.deps.mutations.apply({
      kind: 'upsertRuntimeIntent',
      status: 'stopped',
      sourceCommandId: command.command_id,
      reason: 'explicit stop_project command',
    });
    for (const cardId of this.deps.lifecycle.dispatchInFlight)
      void this.deps.agentRuntime.forceCancelSession(`planner:${cardId}`);
    const stopRunPlans = planOpenRootRunStopUpdates({ state, nowIso: this.deps.now() });
    const stoppedRunIds = stopRunPlans.map((plan) => plan.runId);
    for (const plan of stopRunPlans) {
      const updated = this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId: plan.runId, updates: plan.updates });
      if (updated) this.deps.publishRuntimeRun(updated);
    }
    const current = readRuntimeState(this.deps.projectRoot) ?? state;
    const completedAt = this.deps.now();
    const completion = buildCompletedRuntimeCommandState({
      state: current,
      command,
      at: completedAt,
      statePatch: {
        status: 'idle',
        active_card_run: null,
        current_card_id: null,
        current_agent_session_id: null,
      },
    });
    const completedCommand = completion.completedCommand;
    this.deps.mutations.apply({ kind: 'replaceRuntimeState', state: completion.state });
    this.deps.publishRuntimeCommand(completedCommand);
    this.deps.lifecycle.shuttingDown = false;
    const persisted = readRuntimeState(this.deps.projectRoot) ?? current;
    const stoppedRun =
      stoppedRunIds.length > 0
        ? (persisted.runtime_runs ?? []).find((item) => item.run_id === stoppedRunIds[0])
        : undefined;
    return {
      success: true,
      command: completedCommand,
      intent: persisted.runtime_intent,
      ...(stoppedRun ? { run: stoppedRun } : {}),
    };
  }
}
