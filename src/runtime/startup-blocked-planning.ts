import type { CardRecord } from '../schemas/index.js';
import { lifecycleCardPatch } from './terminal-commit/lifecycle-patch.js';
import { planClearActiveCardRunForRepair } from './runtime-core.js';
import { readRuntimeState } from './state.js';
import { getBlockedPlanning } from './planning-blockers.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export async function alignBlockedPlanningCardStatuses(input: {
  cards: {
    list(): CardRecord[];
    repairTerminalLifecycle(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  };
  transitionCard(cardId: string, event: 'block', details: Record<string, unknown>): Promise<unknown>;
  finishOpenPlannerRun(goalId: string, result: 'blocked'): void;
  projectRoot: string;
  mutations: RuntimeStateMutationPort;
}): Promise<void> {
  for (const card of input.cards.list()) {
    if (card.type !== 'project' && card.type !== 'goal') continue;
    if (card.status === 'blocked') continue;
    const blockedPlanning = getBlockedPlanning(card);
    if (!blockedPlanning) continue;
    const blockedReason = blockedPlanning.blocked_reason || 'Planner context exceeded the selected LLM token budget before scheduler output could be produced; compact/trim planner context before resuming.';
    await input.transitionCard(card.id, 'block', { blocked_reason: blockedReason });
    input.finishOpenPlannerRun(card.id, 'blocked');
    await input.cards.repairTerminalLifecycle(card.id, {
      ...lifecycleCardPatch({
        status: 'blocked',
        result: {
          kind: 'planner_blocked',
          blocked_reason: card.lifecycle.error ?? blockedReason,
          resume_reason: blockedPlanning.resume_reason || 'planner_blocked',
          blocker_cause: blockedPlanning.blocker_cause ?? 'generic',
        },
        error: card.lifecycle.error ?? blockedReason,
        completed_at: null,
      }),
      status_text: card.status_text ?? blockedReason,
    });
    const patch = planClearActiveCardRunForRepair({ state: readRuntimeState(input.projectRoot), cardId: card.id });
    if (patch) input.mutations.apply({ kind: 'patchRuntimeState', patch });
  }
}
