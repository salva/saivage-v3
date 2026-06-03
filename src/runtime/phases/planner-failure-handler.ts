import type { CardStore } from '../../cards/store-api.js';
import type { RuntimeRunRecord } from '../../schemas/index.js';
import type { ErrorLogger, EventLogger } from '../../observability/index.js';
import type { RuntimeStateMachine } from '../state-machine.js';
import type { RuntimeStateMutationPort } from '../mutations.js';
import { readRuntimeState } from '../state.js';
import { isPlannerTerminalToolExhaustion } from '../startup-blocked-planning.js';
import {
  classifyPlannerInvocationFailure,
  handlePlannerInvocationFailure,
  selectPlannerInvocationFailureRun,
} from './planner-invocation-failure.js';

export interface PlannerFailureHandlerDeps {
  projectRoot: string;
  cards: CardStore;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  stateMachine: RuntimeStateMachine;
  mutations: RuntimeStateMutationPort;
  emitRuntimeDiagnostic(input: { goal_id?: string; card_id?: string; phase?: string; error: unknown }): void;
  publishRuntimeRun(run: RuntimeRunRecord): void;
  now(): string;
}

export class PlannerFailureHandler {
  constructor(private readonly deps: PlannerFailureHandlerDeps) {}

  async handle(goalId: string, error: unknown): Promise<{ kind: 'handled' } | { kind: 'rethrow'; error: unknown }> {
    const failedRun = selectPlannerInvocationFailureRun({ state: readRuntimeState(this.deps.projectRoot), goalId });
    const failure = classifyPlannerInvocationFailure(error, isPlannerTerminalToolExhaustion);
    return handlePlannerInvocationFailure({
      goalId,
      error,
      failureKind: failure.failureKind,
      providerStatus: failure.providerStatus,
      existingResult: this.deps.cards.read(goalId)?.result,
      failedRun,
      effects: {
        now: this.deps.now,
        emitRuntimeDiagnostic: (input) => this.deps.emitRuntimeDiagnostic(input),
        appendRuntimeDiagnostic: (input) => this.deps.eventLogger.appendEvent({ kind: 'runtime_diagnostic', ...input }),
        appendError: (input) => this.deps.errorLogger.appendError(input),
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.deps.cards.update(cardId, patch),
        updateRuntimeRun: (runId, updates) => this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId, updates }),
        publishRuntimeRun: (run) => this.deps.publishRuntimeRun(run),
        transitionRuntime: (event, details) => this.deps.stateMachine.transition(event, details),
      },
    });
  }
}
