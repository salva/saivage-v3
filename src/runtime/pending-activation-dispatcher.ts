import type { AgentExecutionPort } from '../contracts/index.js';
import type { CardRecord } from '../schemas/index.js';
import type { ErrorLogger, EventLogger } from '../observability/index.js';
import type { CardStore } from '../cards/store-api.js';
import type { RuntimeSkillsPort } from './runtime-config.js';
import type { RuntimeStateMachine } from './state-machine.js';
import type { ActivationUnwindRunner } from './activation-unwind.js';
import {
  selectChildGoalActivationOutcome,
  selectPendingActivationChildCardIds,
} from './activation-unwind.js';
import {
  buildExecutorActiveRunPatch,
  resolveExecutorLastSessionId,
  selectExecutorStartAction,
} from './phases/executor-phase.js';
import { ExecutorPhaseRunner } from './phases/executor-phase-runner.js';
import {
  buildIgnoredExecutorEvidencePatch,
  createExecutorEvidenceRegistrar,
  registerExecutorEvidence,
  summarizeExecutorEvidenceRegistrationFailure,
} from './phases/executor-evidence.js';
import { handleExecutorInvocationFailure } from './phases/executor-invocation-failure.js';
import { handleExecutorCompletion } from './phases/executor-completion-handler.js';
import { buildCardContextBlock } from './context-builder.js';
import { readRuntimeState, updateRuntimeState } from './state.js';

export class PendingActivationDispatcher {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: CardStore;
      agentRuntime: AgentExecutionPort;
      skillsEngine: RuntimeSkillsPort | null;
      stateMachine: RuntimeStateMachine;
      activationUnwind: ActivationUnwindRunner;
      eventLogger: EventLogger;
      errorLogger: ErrorLogger;
      isPaused(): boolean;
      isShuttingDown(): boolean;
      dispatchGoalThroughScheduler(goalId: string): Promise<void>;
      emit(eventName: string, data: Record<string, unknown>): void;
      emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void;
      now(): string;
    },
  ) {}

  async dispatch(goalId: string): Promise<{ dispatchedGoal: boolean; executedTerminal: boolean; failed: boolean }> {
    let activationCards = this.getPendingActivationCards(goalId);
    const goalCard = this.deps.cards.read(goalId);
    let dispatchedGoal = false;
    let executedTerminal = false;
    let failed = false;
    while (activationCards.length > 0 && !this.deps.isShuttingDown()) {
      if (this.deps.isPaused()) return { dispatchedGoal, executedTerminal, failed };
      for (const card of activationCards) {
        if (this.deps.isShuttingDown() || this.deps.isPaused()) return { dispatchedGoal, executedTerminal, failed };
        const callerEdge = this.deps.activationUnwind.findCallerEdge(card.id);
        if (card.type === 'goal') {
          await this.deps.dispatchGoalThroughScheduler(card.id);
          const completedCard = this.deps.cards.read(card.id);
          const outcome = selectChildGoalActivationOutcome(completedCard);
          this.deps.activationUnwind.appendChildUnwindToolResult(
            card.id,
            outcome,
            `Child goal ${card.id} finished with status ${completedCard?.status ?? 'unknown'}.`,
          );
          dispatchedGoal = true;
          if (outcome !== 'done') return { dispatchedGoal, executedTerminal, failed };
          continue;
        }
        {
          const startAction = selectExecutorStartAction(card.status);
          const transitioned =
            startAction === null
              ? true
              : await this.deps.stateMachine.transitionCard(card.id, startAction, {
                  goalId,
                  reason: 'pending_activation_dispatch',
                });
          if (!transitioned) {
            failed = true;
            return { dispatchedGoal, executedTerminal, failed };
          }
        }
        updateRuntimeState(
          this.deps.projectRoot,
          buildExecutorActiveRunPatch({
            card,
            goalId,
            callerEdge,
            at: this.deps.now(),
          }),
        );
        let execResult;
        try {
          execResult = await new ExecutorPhaseRunner({
            agentRuntime: this.deps.agentRuntime,
            skillsEngine: this.deps.skillsEngine,
            buildCardContextBlock: (cardId, parentGoalId) => buildCardContextBlock({ cardId, goalId: parentGoalId, cards: this.deps.cards }),
          }).run({ card, goalId, goalCard });
        } catch (err) {
          await handleExecutorInvocationFailure({
            cardId: card.id,
            goalId,
            error: err,
            effects: {
              emitRuntimeDiagnostic: (input) => this.deps.emitRuntimeDiagnostic(input),
              appendRuntimeDiagnostic: (input) => this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
              appendError: (input) => this.deps.errorLogger.appendError(input),
              transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
              appendChildUnwindToolResult: (cardId, outcome, summary) => this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
              emitCardFailed: (cardId, parentGoalId) => this.emitCardFailed(cardId, parentGoalId),
            },
          });
          failed = true;
          return { dispatchedGoal, executedTerminal, failed };
        }
        const acceptedAt = this.deps.now();
        const stateAfterExecutor = readRuntimeState(this.deps.projectRoot);
        const lastSessionId = resolveExecutorLastSessionId({
          adapterLastSessionId: (
            this.deps.agentRuntime as {
              getLastSessionId?: (role: 'executor', goalId: string, cardId: string) => string | null;
            }
          ).getLastSessionId?.('executor', goalId, card.id),
          activeRunExecutorSessionId: stateAfterExecutor?.active_card_run?.executor_session_id,
          currentAgentSessionId: stateAfterExecutor?.current_agent_session_id,
        });
        const {
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
          ignoredArtifactRegistrations,
          ignoredAttachmentRegistrations,
        } = registerExecutorEvidence(
          createExecutorEvidenceRegistrar({
            projectRoot: this.deps.projectRoot,
            cards: this.deps.cards,
            cardId: card.id,
            onRegistrationError: ({ phase, error, errorMessage }) => {
              this.deps.emitRuntimeDiagnostic({ card_id: card.id, goal_id: goalId, phase, error });
              this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', card_id: card.id, phase, error_message: errorMessage });
              this.deps.errorLogger.appendError({ message: errorMessage, cardId: card.id, goalId, phase });
            },
          }),
          execResult,
        );
        const ignoredEvidencePatch = buildIgnoredExecutorEvidencePatch({
          existingResult: this.deps.cards.read(card.id)?.result,
          ignoredArtifactRegistrations,
          ignoredAttachmentRegistrations,
        });
        if (ignoredEvidencePatch) await this.deps.cards.update(card.id, ignoredEvidencePatch);
        const { registrationFailed, registrationError } = summarizeExecutorEvidenceRegistrationFailure({
          execStatus: execResult.status,
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
        });
        const completion = await handleExecutorCompletion({
          cardId: card.id,
          goalId,
          execResult,
          acceptedAt,
          lastSessionId,
          registrationFailed,
          registrationError,
          artifactRegistrationErrors,
          attachmentRegistrationErrors,
          effects: {
            now: this.deps.now,
            transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
            readCard: (cardId) => this.deps.cards.read(cardId),
            updateCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
            appendChildUnwindToolResult: (cardId, outcome, summary) => this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
            emitCardFailed: (cardId, parentGoalId) => this.emitCardFailed(cardId, parentGoalId),
          },
        });
        executedTerminal = executedTerminal || completion.executedTerminal;
        if (!completion.transitioned || completion.failed) {
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

  private emitCardFailed(cardId: string, parentGoalId: string): void {
    this.deps.emit('card_failed', { card_id: cardId, goal_id: parentGoalId });
    this.deps.eventLogger.appendEvent({ kind: 'card_failed', card_id: cardId, goal_id: parentGoalId });
  }
}
