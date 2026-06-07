import type { ActionableErrorEnvelope, CardLifecycleState, CardRecord, CardStatus, FreezeManifest, HandoffSummary, RuntimeCommandRecord, RuntimeLedgerActivationOutcome, RuntimeLedgerRunOutcome, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import type { ActivationCompletionOutcome } from '../schemas/index.js';
import { TERMINAL_STATUSES } from '../permissions/index.js';
import { deriveCurrentAgentSessionId, deriveCurrentCardId } from './current-run.js';
import { isUnresolvedRuntimeActivationStatus } from './state.js';

// Pause field groups:
// Full pause: { status: 'paused', paused: true, paused_at }
// Full resume: { status: 'idle'|'running', paused: false, paused_at: null }
// Dispatch-paused signal: { status: 'paused' }; the full pause controller applies the rest.

export type RuntimeStateMachineEvent =
  | 'tick'
  | 'paused'
  | 'resumed'
  | 'goal_exit'
  | 'card_terminated'
  | 'goal_completed'
  | 'reviewer_started'
  | 'reviewer_finished';

export function makeRuntimePreconditionError(input: {
  code: string;
  message: string;
  nextAction: string;
  currentState?: Record<string, unknown>;
}): ActionableErrorEnvelope {
  return {
    code: input.code,
    message: input.message,
    currentState: input.currentState,
    nextAction: input.nextAction,
    docsRef: 'docs/runbook/index.md',
  };
}

export function buildRejectedRuntimeCommandState(input: {
  state: RuntimeState;
  command: RuntimeCommandRecord;
  error: ActionableErrorEnvelope;
  at: string;
}): { rejectedCommand: RuntimeCommandRecord; state: RuntimeState } {
  const rejectedCommand: RuntimeCommandRecord = {
    ...input.command,
    status: 'rejected',
    completed_at: input.at,
    error: input.error,
  };
  return {
    rejectedCommand,
    state: {
      ...input.state,
      runtime_commands: (input.state.runtime_commands ?? []).map((item) =>
        item.command_id === input.command.command_id ? rejectedCommand : item,
      ),
      updated_at: input.at,
    },
  };
}

export function buildCompletedRuntimeCommandState(input: {
  state: RuntimeState;
  command: RuntimeCommandRecord;
  at: string;
  statePatch?: Partial<RuntimeState>;
}): { completedCommand: RuntimeCommandRecord; state: RuntimeState } {
  const completedCommand: RuntimeCommandRecord = {
    ...input.command,
    status: 'completed',
    completed_at: input.at,
  };
  return {
    completedCommand,
    state: {
      ...input.state,
      ...input.statePatch,
      runtime_commands: (input.state.runtime_commands ?? []).map((item) =>
        item.command_id === input.command.command_id ? completedCommand : item,
      ),
      updated_at: input.at,
    },
  };
}

export function planRootRunDispatchSuccessUpdate(input: {
  state: RuntimeState | null;
  runId: string;
  nowIso: string;
}): RuntimeRunUpdatePlan | null {
  const currentRun = (input.state?.runtime_runs ?? []).find((item) => item.run_id === input.runId);
  const intentStopped = (input.state?.runtime_intent?.status ?? 'stopped') === 'stopped';
  const alreadyTerminal =
    Boolean(currentRun?.finished_at) ||
    ['stopped', 'failed'].includes(currentRun?.phase ?? '') ||
    ['stopped', 'error'].includes(currentRun?.runtime_status ?? '') ||
    (currentRun?.outcome?.kind === 'completed' && ['stopped', 'failed'].includes(currentRun.outcome.result));
  if (intentStopped || alreadyTerminal) return null;
  return {
    runId: input.runId,
      updates: {
        phase: 'completed',
        runtime_status: 'idle',
        finished_at: input.nowIso,
        outcome: { kind: 'completed', result: 'done', finished_at: input.nowIso },
      },
  };
}

export function planRootRunDispatchFailureUpdate(input: {
  state: RuntimeState | null;
  runId: string;
  nowIso: string;
}): RuntimeRunUpdatePlan | null {
  const currentRun = (input.state?.runtime_runs ?? []).find((item) => item.run_id === input.runId);
  if (
    currentRun?.finished_at ||
    currentRun?.runtime_status === 'error' ||
    currentRun?.runtime_status === 'stopped'
  ) {
    return null;
  }
  return {
    runId: input.runId,
      updates: {
        phase: 'failed',
        runtime_status: 'error',
        finished_at: input.nowIso,
        outcome: { kind: 'completed', result: 'failed', error: 'Root run dispatch failed.', finished_at: input.nowIso },
      },
  };
}

export function planOpenRootRunStopUpdates(input: {
  state: RuntimeState;
  nowIso: string;
}): RuntimeRunUpdatePlan[] {
  return (input.state.runtime_runs ?? [])
    .filter((run) => run.kind === 'root' && !run.finished_at)
    .map((run) => ({
      runId: run.run_id,
      updates: {
        phase: 'stopped',
        runtime_status: 'stopped',
        finished_at: input.nowIso,
        outcome: { kind: 'completed', result: 'stopped', finished_at: input.nowIso },
      },
    }));
}

/** Sets the full pause field group: status, paused, and paused_at. */
export function buildPauseRuntimeStatePatch(pausedAt: string): Partial<RuntimeState> {
  return { status: 'paused', paused: true, paused_at: pausedAt };
}

/** Sets the full resume field group: status, paused, and paused_at. */
export function buildResumeRuntimeStatePatch(state: RuntimeState | null): Partial<RuntimeState> {
  return {
    status: state?.active_card_run ? 'running' : 'idle',
    paused: false,
    paused_at: null,
  };
}

export function buildFreezeRuntimeStatePatch(input: {
  state: RuntimeState | null;
  frozenAt: string;
}): Partial<RuntimeState> {
  return {
    status: 'frozen',
    started_at: input.state?.started_at ?? input.frozenAt,
    paused: true,
    paused_at: input.frozenAt,
  };
}

export function buildFreezeManifest(input: {
  state: RuntimeState | null;
  freezeId: string;
  reason?: string;
  frozenAt: string;
  pid: number;
  handoffSummaries: HandoffSummary[];
  runtimeVersion: string;
}): FreezeManifest {
  return {
    freeze_id: input.freezeId,
    reason: input.reason ?? 'operator requested freeze',
    created_at: input.frozenAt,
    status: 'frozen',
    project_id: 'project',
    pid: input.pid,
    started_at: input.state?.started_at ?? input.frozenAt,
    active_card_run: input.state?.active_card_run ?? null,
    queue: [],
    running_processes: [],
    handoff_summaries: input.handoffSummaries,
    schema_version: 1,
    runtime_version: input.runtimeVersion,
  };
}

export function buildResumeFromFreezeRuntimeStatePatch(manifest: FreezeManifest): Partial<RuntimeState> {
  return {
    status: manifest.active_card_run ? 'running' : 'idle',
    started_at: manifest.started_at,
    active_card_run: manifest.active_card_run ?? null,
    paused: false,
    paused_at: null,
  };
}

export function buildResumeHandoffContext(manifest: FreezeManifest): string | null {
  const handoffSummaries = manifest.handoff_summaries ?? [];
  if (handoffSummaries.length === 0 || !deriveCurrentAgentSessionId({ active_card_run: manifest.active_card_run ?? null })) return null;
  return handoffSummaries
    .map(
      (h) =>
        `[Handoff] Session: ${h.session_id}, Role: ${h.role}, Last action: ${h.last_action}, Next action: ${h.next_action}, Context: ${h.context_summary}`,
    )
    .join('\n');
}

export function planClearActiveCardRunPatch(input: {
  state: RuntimeState | null;
  cardId: string;
}): Partial<RuntimeState> | null {
  if (input.state?.active_card_run?.card_id !== input.cardId) {
    return null;
  }
  return {
    status: 'idle',
    active_card_run: null,
  };
}

export function planSweptCurrentAgentSessionPatch(input: {
  state: RuntimeState | null;
  sweptSessionIds: Iterable<string>;
}): Partial<RuntimeState> | null {
  const currentSessionId = deriveCurrentAgentSessionId(input.state);
  if (!currentSessionId) return null;
  const sweptSet = new Set(input.sweptSessionIds);
  return sweptSet.has(currentSessionId) ? { active_card_run: null, status: 'idle' } : null;
}

export function buildShutdownRuntimeStatePatch(): Partial<RuntimeState> {
  return {
    status: 'idle',
    active_card_run: null,
    paused: false,
    paused_at: null,
  };
}

/** Sets only the dispatch-paused signal; the pause controller applies paused metadata separately. */
export function buildDispatchPausedRuntimeStatePatch(): Partial<RuntimeState> {
  return { status: 'paused' };
}

export interface StartProjectPreconditionDecision {
  error: ActionableErrorEnvelope | null;
  openRootRun: RuntimeRunRecord | null;
  staleRunningIntentWithoutActiveRootRun: boolean;
  retryingTokenBudgetPlanningBlocker: boolean;
  retryingPlanningBlocker: boolean;
}

export function planStartProjectPrecondition(input: {
  state: RuntimeState;
  projectCardId: string;
  projectCardExists: boolean;
  projectCardStatus?: CardStatus | null;
  hasBlockedPlanning: boolean;
  blockedPlanning: Record<string, unknown> | null;
  paused: boolean;
  source: 'operator' | 'tool' | 'runtime' | 'analyst';
}): StartProjectPreconditionDecision {
  const openRootRun = (input.state.runtime_runs ?? []).find(
    (run) => run.kind === 'root' && !run.finished_at,
  ) ?? null;
  const base = {
    openRootRun,
    staleRunningIntentWithoutActiveRootRun: false,
    retryingTokenBudgetPlanningBlocker: false,
    retryingPlanningBlocker: false,
  };
  const retryingTokenBudgetPlanningBlocker =
    input.projectCardExists &&
    input.source !== 'runtime' &&
    input.projectCardStatus === 'blocked' &&
    input.blockedPlanning?.resume_reason === 'planner_context_length_exceeded' &&
    input.blockedPlanning?.failure_kind === 'token_budget_exceeded';
  const retryingPlanningBlocker = retryingTokenBudgetPlanningBlocker;
  const staleRunningIntentWithoutActiveRootRun =
    (input.state.runtime_intent?.status ?? 'stopped') === 'running' &&
    !openRootRun &&
    input.state.status === 'idle' &&
    (input.state.active_card_run ?? null) === null &&
    !input.hasBlockedPlanning;
  const decisionBase = {
    openRootRun,
    staleRunningIntentWithoutActiveRootRun,
    retryingTokenBudgetPlanningBlocker,
    retryingPlanningBlocker,
  };
  if (
    input.paused ||
    input.state.paused ||
    ((input.state.runtime_intent?.status ?? 'stopped') === 'running' &&
      !staleRunningIntentWithoutActiveRootRun &&
      !retryingPlanningBlocker)
  ) {
    return {
      ...decisionBase,
      error: makeRuntimePreconditionError({
        code: 'runtime_start_precondition_failed',
        message: 'Project runtime is already running or paused.',
        nextAction: 'Use stop_project to stop current intent, or resume/unpause before starting again.',
        currentState: {
          intent: input.state.runtime_intent?.status ?? 'stopped',
          paused: input.state.paused,
          activeRunId: openRootRun?.run_id ?? null,
        },
      }),
    };
  }
  return { ...decisionBase, error: null };
}

export function reduceRuntimeEvent(
  currentState: RuntimeState | null,
  event: Exclude<RuntimeStateMachineEvent, 'tick'>,
  payload: Record<string, unknown>,
  nowIso: string,
): Partial<RuntimeState> {
  switch (event) {
    case 'paused':
      return { status: 'paused', paused: true, paused_at: nowIso };
    case 'resumed':
      return { status: currentState?.active_card_run ? 'running' : 'idle', paused: false, paused_at: null };
    case 'goal_exit':
    case 'card_terminated':
    case 'goal_completed':
      return { status: 'idle', active_card_run: null };
    case 'reviewer_started': {
      const activeCardRun = (payload.activeCardRun ?? null) as RuntimeState['active_card_run'];
      return { status: 'running', active_card_run: activeCardRun };
    }
    case 'reviewer_finished':
      return { status: 'idle', active_card_run: null };
  }
}

export type InvariantId = 'I1' | 'I2' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8';

export interface RuntimeInvariantObservation {
  invariant: InvariantId;
  key: string;
  details: Record<string, unknown>;
  correction?: Partial<RuntimeState>;
}

export function observeRuntimeStateInvariants(input: {
  state: RuntimeState;
  currentCardStatus: CardStatus | null;
  readCard?: (cardId: string) => Pick<CardRecord, 'status' | 'lifecycle'> | null;
}): RuntimeInvariantObservation[] {
  const observations: RuntimeInvariantObservation[] = [];
  const { state, currentCardStatus } = input;

  if (state.status === 'running' && (state.active_card_run ?? null) === null) {
    observations.push({
      invariant: 'I1',
      key: 'global',
      details: { status: state.status },
      correction: { status: 'idle' },
    });
  }

  if (state.status === 'idle' && (state.active_card_run ?? null) !== null) {
    observations.push({
      invariant: 'I1',
      key: 'global',
      details: { status: state.status, activeRunCardId: state.active_card_run?.card_id ?? null, activeRunStatus: state.active_card_run?.runtime_status ?? null },
      correction: { status: 'running' },
    });
  }

  const currentCardId = deriveCurrentCardId(state);
  if (currentCardId !== null && currentCardStatus !== null && TERMINAL_STATUSES.has(currentCardStatus)) {
    observations.push({
      invariant: 'I2',
      key: currentCardId,
      details: { cardId: currentCardId, cardStatus: currentCardStatus },
      correction: { status: 'idle', active_card_run: null },
    });
  }

  const readCard = input.readCard;
  if (readCard) {
    const cardIds = new Set<string>();
    if (currentCardId) cardIds.add(currentCardId);
    for (const activation of state.runtime_activations ?? []) cardIds.add(activation.child_card_id);
    for (const run of state.runtime_runs ?? []) cardIds.add(run.card_id);
    for (const cardId of cardIds) {
      const card = readCard(cardId);
      if (!card) continue;
      if (card.status !== card.lifecycle.status) {
        observations.push({ invariant: 'I5', key: cardId, details: { cardId, status: card.status, lifecycleStatus: card.lifecycle.status } });
      }
      if (card.status === 'done' && card.lifecycle.error != null) {
        observations.push({ invariant: 'I5', key: cardId, details: { cardId, status: card.status, error: card.lifecycle.error } });
      }
      if (card.status === 'failed' && (typeof card.lifecycle.error !== 'string' || card.lifecycle.error.length === 0)) {
        observations.push({ invariant: 'I6', key: cardId, details: { cardId, status: card.status, error: card.lifecycle.error ?? null } });
      }
    }
  }

  for (const activation of state.runtime_activations ?? []) {
    const outcome = activation.outcome ?? null;
    if (activation.status === 'needs_verification' && outcome?.kind !== 'paused') {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcome } });
    }
    if (activation.status === 'completed' && outcome && (outcome.kind !== 'completed' || outcome.outcome !== 'done')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcome } });
    }
    if (activation.status === 'failed' && outcome && (outcome.kind !== 'completed' || outcome.outcome !== 'failed')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcome } });
    }
    if (activation.status === 'cancelled' && outcome && (outcome.kind !== 'completed' || outcome.outcome !== 'cancelled')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcome } });
    }
  }

  for (const run of state.runtime_runs ?? []) {
    const outcome = run.outcome ?? null;
    if (run.phase === 'needs_verification' && outcome?.kind !== 'paused') {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, phase: run.phase, outcome } });
    }
    if (run.phase === 'completed' && outcome && (outcome.kind !== 'completed' || outcome.result !== 'done')) {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, phase: run.phase, outcome } });
    }
    if (run.phase === 'failed' && outcome && (outcome.kind !== 'completed' || outcome.result !== 'failed')) {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, phase: run.phase, outcome } });
    }
  }

  return observations;
}

export interface ProjectRootRedispatchDecision {
  shouldRedispatch: boolean;
  cardId?: string;
  reason?: string;
}

export interface RuntimeRunUpdatePlan {
  runId: string;
  updates: Partial<RuntimeRunRecord>;
}

function isOpenPlannerRun(run: RuntimeRunRecord, goalId: string): boolean {
  return (
    run.card_id === goalId &&
    run.phase === 'planner' &&
    run.runtime_status === 'running' &&
    !run.finished_at
  );
}

function preferRootRun(a: RuntimeRunRecord, b: RuntimeRunRecord): number {
  return (b.kind === 'root' ? 1 : 0) - (a.kind === 'root' ? 1 : 0);
}

function canPlannerTerminalUpdateOwnRun(run: RuntimeRunRecord): boolean {
  return run.kind === 'root' || !run.activation_id;
}

export function planPlannerRunSessionBinding(input: {
  state: RuntimeState | null;
  goalId: string;
  plannerSessionId: string;
}): RuntimeRunUpdatePlan | null {
  const { state, goalId, plannerSessionId } = input;
  const openRun = (state?.runtime_runs ?? [])
    .filter(
      (run) =>
        run.card_id === goalId &&
        ['pending', 'planner'].includes(run.phase) &&
        run.runtime_status === 'running' &&
        !run.finished_at &&
        (!run.session_id || run.session_id === plannerSessionId),
    )
    .sort((a, b) => {
      const phase = (b.phase === 'planner' ? 1 : 0) - (a.phase === 'planner' ? 1 : 0);
      if (phase !== 0) return phase;
      return preferRootRun(a, b);
    })[0];
  if (!openRun) return null;
  const updates: Partial<RuntimeRunRecord> = {};
  if (openRun.phase !== 'planner') updates.phase = 'planner';
  if (openRun.session_id !== plannerSessionId) updates.session_id = plannerSessionId;
  return Object.keys(updates).length > 0 ? { runId: openRun.run_id, updates } : null;
}

export function planOpenPlannerRunTerminalUpdate(input: {
  state: RuntimeState | null;
  goalId: string;
  result: 'blocked' | 'failed';
  nowIso: string;
}): RuntimeRunUpdatePlan | null {
  const { state, goalId, result, nowIso } = input;
  const openRun = (state?.runtime_runs ?? [])
    .filter(
      (run) =>
        isOpenPlannerRun(run, goalId) &&
        (!run.session_id || run.session_id === `planner:${goalId}`) &&
        canPlannerTerminalUpdateOwnRun(run),
    )
    .sort(preferRootRun)[0];
  if (!openRun) return null;
  return {
    runId: openRun.run_id,
      updates: {
        phase: result,
        runtime_status: 'error',
        finished_at: nowIso,
        updated_at: nowIso,
        outcome: result === 'blocked' ? { kind: 'blocked', error: 'Planner run blocked.' } : { kind: 'completed', result: 'failed', error: 'Planner run failed.', finished_at: nowIso },
      },
  };
}

export interface IdleRunningRootRunReconciliationPlan {
  runUpdates: RuntimeRunUpdatePlan[];
  statePatch?: Partial<RuntimeState>;
  diagnosticMessage: string;
}

export function planIdleRunningRootRunReconciliation(input: {
  state: RuntimeState;
  projectTerminal: boolean;
  projectLifecycle?: CardLifecycleState | null;
  nowIso: string;
}): IdleRunningRootRunReconciliationPlan | null {
  const { state, projectTerminal, nowIso } = input;
  const outcome = input.projectLifecycle ? runtimeRunOutcomeFromLifecycle(input.projectLifecycle) : null;
  if (
    (state.runtime_intent?.status ?? 'stopped') !== 'running' ||
    state.status !== 'idle' ||
    (state.active_card_run ?? null) !== null
  ) {
    return null;
  }
  const openRuns = (state.runtime_runs ?? []).filter((run) => run.runtime_status === 'running' && !run.finished_at);
  const openRootRuns = openRuns.filter((run) => run.kind === 'root');
  if (openRuns.length === 0) {
    if (!projectTerminal) return null;
    return {
      runUpdates: [],
      statePatch: {
        runtime_intent: {
          status: 'stopped',
          source_command_id: state.runtime_intent?.source_command_id ?? null,
          updated_at: nowIso,
          reason: 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.',
        },
        status: 'idle',
        active_card_run: null,
        updated_at: nowIso,
      },
      diagnosticMessage: 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.',
    };
  }
  return {
    runUpdates: openRuns.map((run) => {
      const isTerminalRootRun = run.kind === 'root' && projectTerminal;
      return {
        runId: run.run_id,
        updates: {
          phase: isTerminalRootRun ? 'completed' : 'failed',
          runtime_status: isTerminalRootRun ? 'idle' : 'error',
          finished_at: nowIso,
          updated_at: nowIso,
          outcome: isTerminalRootRun
            ? outcome ?? { kind: 'completed', result: 'done', finished_at: nowIso }
            : { kind: 'completed', result: 'failed', error: 'Runtime was idle with an open runtime run.', finished_at: nowIso },
        },
      };
    }),
    diagnosticMessage: projectTerminal
      ? 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.'
      : 'Reconciled running runtime intent with open runtime run while runtime was idle and had no active card run.',
  };
}

export function planProjectRootRedispatch(input: {
  state: RuntimeState;
  projectCardId: string;
}): ProjectRootRedispatchDecision {
  const { state, projectCardId } = input;
  if (state.paused) return { shouldRedispatch: false };
  if (state.status !== 'idle') return { shouldRedispatch: false };
  if ((state.active_card_run ?? null) !== null) return { shouldRedispatch: false };
  const intentStatus = state.runtime_intent?.status ?? 'stopped';
  if (intentStatus !== 'running') return { shouldRedispatch: false };
  const rootRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'root' && run.card_id === projectCardId);
  const openRootRun = rootRuns.find((run) => !run.finished_at);
  if (openRootRun) return { shouldRedispatch: true, cardId: projectCardId, reason: 'open_root_run' };
  const latestRootRun = rootRuns.slice().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
  if ((latestRootRun?.outcome?.kind === 'completed' && latestRootRun.outcome.result === 'failed') || latestRootRun?.runtime_status === 'error' || latestRootRun?.phase === 'failed') {
    return { shouldRedispatch: true, cardId: projectCardId, reason: 'failed_root_run_with_running_intent' };
  }
  return { shouldRedispatch: false };
}

export function activationOutcomeFromLifecycle(input: {
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

export function runtimeRunOutcomeFromLifecycle(lifecycle: CardLifecycleState): RuntimeLedgerRunOutcome | null {
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
  const runs = (currentState.runtime_runs ?? []).map((run) =>
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
  return {
    ...currentState,
    ...(currentState.active_card_run?.card_id === childCardId ? { status: 'idle' as const, active_card_run: null } : {}),
    runtime_activations: activations,
    runtime_runs: runs,
    updated_at: nowIso,
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
