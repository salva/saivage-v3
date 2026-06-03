import type { CardRecord } from '../schemas/index.js';
import { planClearActiveCardRunPatch } from './runtime-core.js';
import { readRuntimeState } from './state.js';
import { buildPlannerInvocationFailureBlocker } from './phases/planner-phase.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export function isPlannerTerminalToolExhaustion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Role 'planner' did not emit terminal tool within \d+ turns\./.test(message);
}

export async function alignBlockedPlanningCardStatuses(input: {
  cards: {
    list(): CardRecord[];
    update(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  };
  transitionCard(cardId: string, event: 'block', details: Record<string, unknown>): Promise<unknown>;
  finishOpenPlannerRun(goalId: string, result: 'blocked'): void;
  projectRoot: string;
  mutations: RuntimeStateMutationPort;
}): Promise<void> {
  for (const card of input.cards.list()) {
    if (card.type !== 'project' && card.type !== 'goal') continue;
    if (card.status === 'failed' && isPlannerTerminalToolExhaustion(card.error ?? '')) {
      const plannerFailureBlocker = buildPlannerInvocationFailureBlocker({
        tokenBudgetFailure: false,
        providerStatus: null,
      });
      await input.cards.update(card.id, {
        status: 'blocked',
        error: plannerFailureBlocker.blockedReason,
        status_text: plannerFailureBlocker.blockedReason,
        result: {
          ...(card.result ?? {}),
          planning: plannerFailureBlocker.planning,
        },
      });
      input.finishOpenPlannerRun(card.id, 'blocked');
      const patch = planClearActiveCardRunPatch({ state: readRuntimeState(input.projectRoot), cardId: card.id });
      if (patch) input.mutations.apply({ kind: 'patchRuntimeState', patch });
      continue;
    }
    if (card.status === 'blocked') continue;
    const planning =
      card.result && typeof card.result === 'object'
        ? (card.result as { planning?: unknown }).planning
        : null;
    if (!planning || typeof planning !== 'object') continue;
    const blockedPlanning = planning as {
      status?: unknown;
      resume_reason?: unknown;
      failure_kind?: unknown;
      blocked_reason?: unknown;
    };
    if (blockedPlanning.status !== 'blocked') continue;
    const blockedReason =
      typeof blockedPlanning.blocked_reason === 'string'
        ? blockedPlanning.blocked_reason
        : 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    await input.transitionCard(card.id, 'block', { blocked_reason: blockedReason });
    input.finishOpenPlannerRun(card.id, 'blocked');
    await input.cards.update(card.id, {
      status: 'blocked',
      error: card.error ?? blockedReason,
      status_text: card.status_text ?? blockedReason,
    });
    const patch = planClearActiveCardRunPatch({ state: readRuntimeState(input.projectRoot), cardId: card.id });
    if (patch) input.mutations.apply({ kind: 'patchRuntimeState', patch });
  }
}
