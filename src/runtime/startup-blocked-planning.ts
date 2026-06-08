import type { CardRecord, RuntimeState } from '../schemas/index.js';
import { lifecycleCardPatch } from './terminal-commit/lifecycle-patch.js';
import { planClearActiveCardRunForRepair } from './runtime-core.js';
import { readRuntimeState } from './state.js';
import { getBlockedPlanning } from './planning-blockers.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import { TERMINAL_STATUSES } from '../permissions/index.js';

const PLANNING_COMPATIBLE_INTERRUPTED_STATUSES = new Set<CardRecord['status']>(['running']);

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
  const startupState = readRuntimeState(input.projectRoot);
  for (const card of input.cards.list()) {
    if (card.type !== 'project' && card.type !== 'goal') continue;
    if (card.status !== card.lifecycle.status) {
      throw new Error(`Startup blocked-planning invariant violation: card '${card.id}' status '${card.status}' contradicts lifecycle status '${card.lifecycle.status}'.`);
    }
    const blockedPlanning = getBlockedPlanning(card);
    if (!blockedPlanning) continue;
    if (card.status === 'blocked') {
      input.finishOpenPlannerRun(card.id, 'blocked');
      const patch = planClearActiveCardRunForRepair({ state: readRuntimeState(input.projectRoot), cardId: card.id });
      if (patch) input.mutations.apply({ kind: 'patchRuntimeState', patch });
      continue;
    }
    if (TERMINAL_STATUSES.has(card.status)) {
      throw new Error(`Startup blocked-planning invariant violation: terminal card '${card.id}' has blocked-planning metadata.`);
    }
    if (!PLANNING_COMPATIBLE_INTERRUPTED_STATUSES.has(card.status)) {
      throw new Error(`Startup blocked-planning invariant violation: card '${card.id}' has blocked-planning metadata while status '${card.status}' is not repairable.`);
    }
    if (!hasInterruptedPlannerOwnership(startupState, card.id)) {
      throw new Error(`Startup blocked-planning invariant violation: card '${card.id}' has blocked-planning metadata without persisted planner ownership.`);
    }
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

function hasInterruptedPlannerOwnership(state: RuntimeState | null, cardId: string): boolean {
  const activeRun = state?.active_card_run ?? null;
  if (
    activeRun?.card_id === cardId &&
    activeRun.phase === 'planner' &&
    activeRun.runtime_status === 'running' &&
    Boolean(activeRun.ownership) &&
    Boolean(activeRun.planner_session_id)
  ) {
    return true;
  }
  return (state?.runtime_runs ?? []).some(
    (run) =>
      run.card_id === cardId &&
      (run.phase === 'pending' || run.phase === 'planner') &&
      run.runtime_status === 'running' &&
      !run.finished_at &&
      Boolean(run.ownership),
  );
}
