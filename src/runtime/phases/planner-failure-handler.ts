import type { RuntimeRunRecord } from '../../schemas/index.js';
import type { RuntimeServices } from '../runtime-services.js';
import { readRuntimeState } from '../state.js';
import {
  classifyPlannerInvocationFailure,
  handlePlannerInvocationFailure,
  selectPlannerInvocationFailureRun,
} from './planner-invocation-failure.js';

export interface PlannerFailureHandlerDeps extends Pick<RuntimeServices,
  | 'projectRoot'
  | 'cards'
  | 'errorLogger'
  | 'stateMachine'
  | 'mutations'
  | 'publishRuntimeDiagnostic'
  | 'now'
> {
  publishRuntimeRun(run: RuntimeRunRecord): void;
}

export class PlannerFailureHandler {
  constructor(private readonly deps: PlannerFailureHandlerDeps) {}

  async handle(goalId: string, error: unknown): Promise<{ kind: 'handled' } | { kind: 'rethrow'; error: unknown }> {
    const failedRun = selectPlannerInvocationFailureRun({ state: readRuntimeState(this.deps.projectRoot), goalId });
    const failure = classifyPlannerInvocationFailure(error);
    return handlePlannerInvocationFailure({
      goalId,
      error,
      failureKind: failure.failureKind,
      providerStatus: failure.providerStatus,
      currentCard: this.deps.cards.read(goalId),
      failedRun,
      effects: {
        now: this.deps.now,
        publishRuntimeDiagnostic: (input) => this.deps.publishRuntimeDiagnostic(input),
        appendError: (input) => this.deps.errorLogger.appendError(input),
        transitionCard: (cardId, event, details) => this.deps.stateMachine.transitionCard(cardId, event, details),
        updateCard: (cardId, patch) => this.deps.cards.repairTerminalLifecycle(cardId, patch),
        updateRuntimeRun: (runId, updates) => this.deps.mutations.apply({ kind: 'updateRuntimeRun', runId, updates }),
        publishRuntimeRun: (run) => this.deps.publishRuntimeRun(run),
        transitionRuntime: (event, details) => this.deps.stateMachine.transition(event, details),
      },
    });
  }
}
