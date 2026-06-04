import type { CardRecord, RuntimeRunRecord, RuntimeState } from '../../schemas/index.js';
import { unwrapFailure, type LlmTransportFailure } from '../../contracts/llm-failure.js';
import { buildPlannerInvocationFailureBlocker } from './planner-phase.js';
import { commitPlannerBlocked } from '../terminal-commit/index.js';

export type PlannerInvocationFailureKind = 'token_budget' | 'terminal_tool' | 'generic';

function isTokenBudgetFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { failure?: unknown }).failure) {
    const failure = (error as { failure: LlmTransportFailure }).failure;
    if (failure?.kind === 'token_budget_exceeded') return true;
  }
  const failure = unwrapFailure(error);
  if (failure.kind === 'token_budget_exceeded') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /context_length_exceeded|token budget exceeded|maximum context length/i.test(message);
}

export function classifyPlannerInvocationFailure(
  error: unknown,
  isTerminalToolExhaustion: (error: unknown) => boolean,
): { failureKind: PlannerInvocationFailureKind; providerStatus: number | null } {
  const tokenBudgetFailure = isTokenBudgetFailure(error);
  return {
    failureKind: tokenBudgetFailure ? 'token_budget' : isTerminalToolExhaustion(error) ? 'terminal_tool' : 'generic',
    providerStatus: tokenBudgetFailure ? ((error as { failure?: { status?: number } }).failure?.status ?? null) : null,
  };
}

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
  currentCard: CardRecord | null | undefined;
  failedRun: RuntimeRunRecord | null | undefined;
  effects: PlannerInvocationFailureEffects;
}): Promise<{ kind: 'handled' } | { kind: 'rethrow'; error: unknown }> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  input.effects.emitRuntimeDiagnostic({ goal_id: input.goalId, phase: 'planner', error: input.error });
  input.effects.appendRuntimeDiagnostic({ goal_id: input.goalId, phase: 'planner', error_message: errorMessage });
  input.effects.appendError({ message: errorMessage, goalId: input.goalId, phase: 'planner' });

  if (input.failureKind === 'token_budget' || input.failureKind === 'terminal_tool') {
    if (!input.currentCard) throw new Error(`Cannot block missing planner goal '${input.goalId}'.`);
    const plannerFailureBlocker = buildPlannerInvocationFailureBlocker({
      tokenBudgetFailure: input.failureKind === 'token_budget',
      providerStatus: input.providerStatus,
    });
    await commitPlannerBlocked({
      card: input.currentCard,
      blockedReason: plannerFailureBlocker.blockedReason,
      resumeReason: plannerFailureBlocker.resumeReason,
      createdCards: [],
      updatedCards: [],
      effects: {
        transitionCard: (cardId, event, details) => input.effects.transitionCard(cardId, event as 'block', details),
        updateCard: (cardId, patch) => input.effects.updateCard(cardId, patch),
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
