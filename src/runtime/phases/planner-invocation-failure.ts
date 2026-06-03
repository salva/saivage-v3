import type { CardRecord, RuntimeRunRecord, RuntimeState } from '../../schemas/index.js';
import { buildPlannerInvocationFailureBlocker } from './planner-phase.js';

export type PlannerInvocationFailureKind = 'token_budget' | 'terminal_tool' | 'generic';

export interface PlannerInvocationFailureEffects {
  now(): string;
  emitRuntimeDiagnostic(input: { goal_id: string; phase: 'planner'; error: unknown }): void;
  appendRuntimeDiagnostic(input: { goal_id: string; phase: 'planner'; error_message: string }): void;
  appendError(input: { message: string; goalId: string; phase: 'planner' }): void;
  transitionCard(cardId: string, event: 'block' | 'fail', details: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  updateRuntimeRun(runId: string, updates: Partial<RuntimeRunRecord>): RuntimeRunRecord | null;
  publishRuntimeRun(run: RuntimeRunRecord): void;
  transitionRuntime(event: 'card_terminated' | 'goal_exit', details: Record<string, unknown>): Promise<unknown>;
}

export function selectPlannerInvocationFailureRun(input: {
  state: RuntimeState | null;
  goalId: string;
}): RuntimeRunRecord | null {
  return (input.state?.runtime_runs ?? [])
    .filter(
      (run) =>
        run.card_id === input.goalId &&
        run.phase === 'planner' &&
        run.runtime_status === 'running' &&
        !run.finished_at &&
        (!run.session_id || run.session_id === `planner:${input.goalId}`) &&
        (run.kind === 'root' || !run.activation_id),
    )
    .sort((a, b) => (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0))[0] ?? null;
}

export async function handlePlannerInvocationFailure(input: {
  goalId: string;
  error: unknown;
  failureKind: PlannerInvocationFailureKind;
  providerStatus: number | null;
  existingResult: CardRecord['result'] | undefined;
  failedRun: RuntimeRunRecord | null | undefined;
  effects: PlannerInvocationFailureEffects;
}): Promise<{ kind: 'handled' } | { kind: 'rethrow'; error: unknown }> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  input.effects.emitRuntimeDiagnostic({ goal_id: input.goalId, phase: 'planner', error: input.error });
  input.effects.appendRuntimeDiagnostic({ goal_id: input.goalId, phase: 'planner', error_message: errorMessage });
  input.effects.appendError({ message: errorMessage, goalId: input.goalId, phase: 'planner' });

  if (input.failureKind === 'token_budget' || input.failureKind === 'terminal_tool') {
    const plannerFailureBlocker = buildPlannerInvocationFailureBlocker({
      tokenBudgetFailure: input.failureKind === 'token_budget',
      providerStatus: input.providerStatus,
    });
    await input.effects.transitionCard(input.goalId, 'block', {
      blocked_reason: plannerFailureBlocker.blockedReason,
    });
    await input.effects.updateCard(input.goalId, {
      status: 'blocked',
      error: plannerFailureBlocker.blockedReason,
      status_text: plannerFailureBlocker.blockedReason,
      result: {
        ...(input.existingResult ?? {}),
        planning: plannerFailureBlocker.planning,
      },
    });
    if (input.failedRun) {
      const updated = input.effects.updateRuntimeRun(input.failedRun.run_id, {
        phase: 'blocked',
        runtime_status: 'error',
        finished_at: input.effects.now(),
        result: 'blocked',
      });
      if (updated) input.effects.publishRuntimeRun(updated);
    }
    await input.effects.transitionRuntime('card_terminated', {
      goalId: input.goalId,
      reason: plannerFailureBlocker.resumeReason,
    });
    return { kind: 'handled' };
  }

  await input.effects.transitionCard(input.goalId, 'fail', {
    reason: 'planner_error',
    error: errorMessage,
  });
  await input.effects.updateCard(input.goalId, {
    error: errorMessage,
    status_text: `Planner failed: ${errorMessage}`,
  });
  if (input.failedRun) {
    const updated = input.effects.updateRuntimeRun(input.failedRun.run_id, {
      phase: 'failed',
      runtime_status: 'error',
      finished_at: input.effects.now(),
      result: 'failed',
    });
    if (updated) input.effects.publishRuntimeRun(updated);
  }
  await input.effects.transitionRuntime('goal_exit', { goalId: input.goalId, reason: 'planner_error' });
  return { kind: 'rethrow', error: input.error };
}
