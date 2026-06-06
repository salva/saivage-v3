import type { AgentExecutionPort } from '../contracts/index.js';
import type { CardRecord } from '../schemas/index.js';
import type { RuntimeSkillsPort } from './runtime-config.js';
import type { ActivationCallerEdge, ActivationUnwindRunner } from './activation-unwind.js';
import {
  buildExecutorActiveRunPatch,
  resolveExecutorLastSessionId,
} from './phases/executor-phase.js';
import { ExecutorPhaseRunner } from './phases/executor-phase-runner.js';
import {
  createExecutorEvidenceRegistrar,
  registerExecutorEvidence,
  summarizeExecutorEvidenceRegistrationFailure,
  validateExecutorGeneratedFiles,
} from './phases/executor-evidence.js';
import { handleExecutorInvocationFailure } from './phases/executor-invocation-failure.js';
import { handleExecutorCompletion } from './phases/executor-completion-handler.js';
import { buildCardContextBlock } from './context-builder.js';
import { readRuntimeState } from './state.js';
import type { RuntimeServices } from './runtime-services.js';
import { planClearActiveCardRunPatch } from './runtime-core.js';
import { deriveCurrentAgentSessionId } from './current-run.js';
import { selectActivationStartAction } from './transition-policy.js';

export interface ExecutorActivationDispatcherDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'cards'
  | 'eventLogger'
  | 'errorLogger'
  | 'stateMachine'
  | 'mutations'
  | 'emit'
  | 'emitRuntimeDiagnostic'
  | 'now'
> {
  agentRuntime: AgentExecutionPort;
  skillsEngine: RuntimeSkillsPort | null;
  activationUnwind: ActivationUnwindRunner;
}

export class ExecutorActivationDispatcher {
  constructor(private readonly deps: ExecutorActivationDispatcherDeps) {}

  async dispatch(input: {
    goalId: string;
    goalCard: CardRecord | null;
    card: CardRecord;
    callerEdge: ActivationCallerEdge | null;
  }): Promise<{ executedTerminal: boolean; failed: boolean }> {
    const { goalId, goalCard, card, callerEdge } = input;
    const startAction = selectActivationStartAction(card.status, 'executor');
    if (startAction.action === 'reject') return { executedTerminal: false, failed: true };
    const transitioned =
      startAction.action === 'none'
        ? true
        : await this.deps.stateMachine.transitionCard(card.id, startAction.action, {
            goalId,
            reason: 'pending_activation_dispatch',
          });
    if (!transitioned) return { executedTerminal: false, failed: true };

    this.deps.mutations.apply({
      kind: 'patchRuntimeState',
      patch: buildExecutorActiveRunPatch({
        card,
        goalId,
        callerEdge,
        at: this.deps.now(),
      }),
    });

    let execResult;
    try {
      execResult = await new ExecutorPhaseRunner({
        agentRuntime: this.deps.agentRuntime,
        skillsEngine: this.deps.skillsEngine,
        buildCardContextBlock: (cardId, parentGoalId) => buildCardContextBlock({ cardId, goalId: parentGoalId, cards: this.deps.cards }),
      }).run({ card, goalId, goalCard });
    } catch (err) {
      await handleExecutorInvocationFailure({
        card,
        cardId: card.id,
        goalId,
        error: err,
        effects: {
          emitRuntimeDiagnostic: (effectInput) => this.deps.emitRuntimeDiagnostic(effectInput),
          appendRuntimeDiagnostic: (effectInput) => this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...effectInput }),
          appendError: (effectInput) => this.deps.errorLogger.appendError(effectInput),
          transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
          updateCard: (cardId, patch) => this.deps.cards.repairTerminalLifecycle(cardId, patch),
          appendChildUnwindToolResult: (cardId, outcome, summary) => this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
          clearActiveCardRun: (cardId) => {
            const patch = planClearActiveCardRunPatch({ state: readRuntimeState(this.deps.projectRoot), cardId });
            if (patch) this.deps.mutations.apply({ kind: 'patchRuntimeState', patch });
          },
          emitCardFailed: (cardId, parentGoalId) => this.emitCardFailed(cardId, parentGoalId),
          now: this.deps.now,
        },
      });
      return { executedTerminal: false, failed: true };
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
      currentAgentSessionId: deriveCurrentAgentSessionId(stateAfterExecutor),
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
    const { registrationFailed, registrationError } = summarizeExecutorEvidenceRegistrationFailure({
      execStatus: execResult.status,
      artifactRegistrationErrors,
      attachmentRegistrationErrors,
      generatedFileValidationErrors: validateExecutorGeneratedFiles(this.deps.projectRoot, execResult),
    });
    const completion = await handleExecutorCompletion({
      projectRoot: this.deps.projectRoot,
      card,
      cardId: card.id,
      goalId,
      execResult,
      acceptedAt,
      lastSessionId,
      registrationFailed,
      registrationError,
      artifactRegistrationErrors,
      attachmentRegistrationErrors,
      ignoredArtifactRegistrations,
      ignoredAttachmentRegistrations,
      effects: {
        now: this.deps.now,
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        readCard: (cardId) => this.deps.cards.read(cardId),
        updateCard: (cardId, patch) => this.deps.cards.commitTerminalLifecyclePatch(cardId, patch),
        appendChildUnwindToolResult: (cardId, outcome, summary) => this.deps.activationUnwind.appendChildUnwindToolResult(cardId, outcome, summary),
        recordChildActivationLifecycle: (cardId, lifecycle) => this.deps.activationUnwind.recordChildActivationLifecycle(cardId, lifecycle),
        emitCardFailed: (cardId, parentGoalId) => this.emitCardFailed(cardId, parentGoalId),
      },
    });
    return {
      executedTerminal: completion.executedTerminal,
      failed: !completion.transitioned || completion.failed,
    };
  }

  private emitCardFailed(cardId: string, parentGoalId: string): void {
    this.deps.emit('card_failed', { card_id: cardId, goal_id: parentGoalId });
    this.deps.eventLogger.appendEvent({ kind: 'card_failed', card_id: cardId, goal_id: parentGoalId });
  }
}
