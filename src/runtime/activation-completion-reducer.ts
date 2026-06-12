import type { ActivationCompletionOutcome, CardLifecycleState, RuntimeActivationRecord, RuntimeLedgerActivationOutcome, RuntimeLedgerRunOutcome, RuntimeState } from '../schemas/index.js';
import { isUnresolvedRuntimeActivationStatus, RuntimeStateInvariantError } from './state.js';

export function reduceActivationCompletion(
  currentState: RuntimeState | null,
  childCardId: string,
  outcome: ActivationCompletionOutcome,
  nowIso: string,
  lifecycle?: CardLifecycleState | null,
): RuntimeState | null {
  if (!currentState?.runtime_activations?.length) return null;
  const terminalStatus = outcome === 'done' ? 'completed' : outcome;
  const activationOutcome = lifecycle ? activationOutcomeFromLifecycle({ cardId: childCardId, lifecycle }) : activationOutcomeFromCompletion(childCardId, outcome, nowIso);
  const runOutcome = lifecycle ? runtimeRunOutcomeFromLifecycle(lifecycle) : runtimeRunOutcomeFromCompletion(outcome, nowIso);
  const transitioningActivations = currentState.runtime_activations.filter(
    (activation) =>
      activation.child_card_id === childCardId &&
      isUnresolvedRuntimeActivationStatus(activation.status),
  );
  const completedActivationIds = new Set(transitioningActivations.map((activation) => activation.activation_id));
  const completedRunIds = new Set(transitioningActivations.map((activation) => activation.runtime_run_id).filter((runId): runId is string => typeof runId === 'string'));
  const activations = currentState.runtime_activations.map((activation) =>
    completedActivationIds.has(activation.activation_id)
      ? { ...activation, status: terminalStatus as typeof activation.status, updated_at: nowIso, ...(activationOutcome ? { outcome: activationOutcome } : {}) }
      : activation,
  );
  const runs = currentState.runtime_runs.map((run) =>
    run.card_id === childCardId &&
    (completedRunIds.has(run.run_id) || completedActivationIds.has(run.activation_id ?? '')) &&
    !run.finished_at
      ? {
          ...run,
          phase: terminalStatus as typeof run.phase,
          runtime_status: outcome === 'done' ? ('idle' as const) : ('error' as const),
          finished_at: nowIso,
          updated_at: nowIso,
          ...(runOutcome ? { outcome: runOutcome } : {}),
        }
      : run,
  );
  let activeCardRunPatch: Partial<Pick<RuntimeState, 'status' | 'active_card_run'>> = {};
  if (currentState.active_card_run?.card_id === childCardId) {
    assertSingleActiveChildActivation(childCardId, transitioningActivations);
    const completedActivation = transitioningActivations[0];
    const parentPlannerRun = findParentPlannerRunForResumption(currentState, completedActivation);
    if (parentPlannerRun) {
      activeCardRunPatch = { status: 'running', active_card_run: parentPlannerRun };
    } else {
      throw new RuntimeStateInvariantError(
        `Runtime activation invariant violation: child activation '${completedActivation.activation_id}' for '${childCardId}' completed without an open parent planner run '${completedActivation.parent_run_id}' for parent '${completedActivation.parent_card_id}'. Sequential runtime execution requires the parent planner run to remain open until the child activation completes.`,
      );
    }
  }

  return {
    ...currentState,
    ...activeCardRunPatch,
    runtime_activations: activations,
    runtime_runs: runs,
    updated_at: nowIso,
  };
}

function activationOutcomeFromLifecycle(input: {
  cardId: string;
  lifecycle: CardLifecycleState;
}): RuntimeLedgerActivationOutcome | null {
  const { cardId, lifecycle } = input;
  switch (lifecycle.status) {
    case 'done':
      return { kind: 'completed', outcome: 'done', card_id: cardId, completed_at: lifecycle.completed_at };
    case 'failed':
      return { kind: 'completed', outcome: 'failed', card_id: cardId, error: lifecycle.error, completed_at: lifecycle.completed_at };
    case 'cancelled':
      return { kind: 'completed', outcome: 'cancelled', card_id: cardId, completed_at: lifecycle.completed_at };
    case 'blocked':
      return { kind: 'blocked', card_id: cardId, error: lifecycle.error };
    case 'needs_verification':
      return { kind: 'paused', reason: 'needs_verification', card_id: cardId, detail: needsVerificationDetail(lifecycle) };
    default:
      return null;
  }
}

function runtimeRunOutcomeFromLifecycle(lifecycle: CardLifecycleState): RuntimeLedgerRunOutcome | null {
  switch (lifecycle.status) {
    case 'done':
      return { kind: 'completed', result: 'done', finished_at: lifecycle.completed_at };
    case 'failed':
      return { kind: 'completed', result: 'failed', error: lifecycle.error, finished_at: lifecycle.completed_at };
    case 'cancelled':
      return lifecycle.completed_at ? { kind: 'completed', result: 'cancelled', finished_at: lifecycle.completed_at } : null;
    case 'blocked':
      return { kind: 'blocked', error: lifecycle.error };
    case 'needs_verification':
      return { kind: 'paused', reason: 'needs_verification', detail: needsVerificationDetail(lifecycle) };
    default:
      return null;
  }
}

function needsVerificationDetail(lifecycle: Extract<CardLifecycleState, { status: 'needs_verification' }>): string {
  const result = lifecycle.result;
  if (result && typeof result === 'object' && typeof (result as { reason?: unknown }).reason === 'string' && (result as { reason: string }).reason.trim()) {
    return (result as { reason: string }).reason;
  }
  return 'Card is parked for verification.';
}

function assertSingleActiveChildActivation(
  childCardId: string,
  transitioningActivations: RuntimeActivationRecord[],
): asserts transitioningActivations is [RuntimeActivationRecord] {
  if (transitioningActivations.length === 1) return;
  throw new RuntimeStateInvariantError(
    `Runtime activation invariant violation: expected exactly one unresolved activation for active child '${childCardId}', found ${transitioningActivations.length}.`,
  );
}

function findParentPlannerRunForResumption(
  state: RuntimeState,
  completedActivation: RuntimeActivationRecord,
): NonNullable<RuntimeState['active_card_run']> | null {
  const parentCardId = completedActivation.parent_card_id;
  const parentSessionId = completedActivation.parent_session_id;
  const parentRunId = completedActivation.parent_run_id;
  const candidates = state.runtime_runs.filter(
    (run) =>
      run.card_id === parentCardId &&
      run.phase === 'planner' &&
      run.runtime_status === 'running' &&
      !run.finished_at &&
      run.run_id === parentRunId,
  );
  const parentRun = candidates.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!parentRun) return null;
  if (!parentRun.session_id) {
    throw new RuntimeStateInvariantError(
      `Runtime activation invariant violation: parent planner run '${parentRun.run_id}' for '${parentCardId}' has no session identity to resume after child activation '${completedActivation.activation_id}'.`,
    );
  }
  if (parentRun.session_id !== parentSessionId) {
    throw new RuntimeStateInvariantError(
      `Runtime activation invariant violation: parent planner run '${parentRun.run_id}' session '${parentRun.session_id}' contradicts activation parent session '${parentSessionId}'.`,
    );
  }
  return {
    card_id: parentCardId,
    card_type: parentCardId === 'project' ? 'project' : 'goal',
    ownership: parentRun.ownership,
    runtime_status: 'running',
    phase: 'planner',
    caller_session_id: parentRun.ownership.kind === 'activation' ? parentRun.ownership.parent_session_id : null,
    caller_tool_call_id: parentRun.ownership.kind === 'activation' ? parentRun.ownership.parent_tool_call_id : null,
    planner_session_id: parentRun.session_id,
    correction_attempts: 0,
    started_at: parentRun.started_at,
    last_turn_at: parentRun.updated_at,
  };
}

function activationOutcomeFromCompletion(cardId: string, outcome: ActivationCompletionOutcome, completedAt: string): RuntimeLedgerActivationOutcome {
  switch (outcome) {
    case 'done':
      return { kind: 'completed', outcome: 'done', card_id: cardId, completed_at: completedAt };
    case 'blocked':
      return { kind: 'blocked', card_id: cardId, error: 'Activation blocked.' };
    case 'cancelled':
      return { kind: 'completed', outcome: 'cancelled', card_id: cardId, completed_at: completedAt };
    case 'needs_verification':
      return { kind: 'paused', reason: 'needs_verification', card_id: cardId, detail: 'Card is parked for verification.' };
    default:
      return { kind: 'completed', outcome: 'failed', card_id: cardId, error: 'Activation failed.', completed_at: completedAt };
  }
}

function runtimeRunOutcomeFromCompletion(outcome: ActivationCompletionOutcome, finishedAt: string): RuntimeLedgerRunOutcome {
  switch (outcome) {
    case 'done':
      return { kind: 'completed', result: 'done', finished_at: finishedAt };
    case 'blocked':
      return { kind: 'blocked', error: 'Activation blocked.' };
    case 'cancelled':
      return { kind: 'completed', result: 'cancelled', finished_at: finishedAt };
    case 'needs_verification':
      return { kind: 'paused', reason: 'needs_verification', detail: 'Card is parked for verification.' };
    default:
      return { kind: 'completed', result: 'failed', error: 'Activation failed.', finished_at: finishedAt };
  }
}
