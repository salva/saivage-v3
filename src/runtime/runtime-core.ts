import type { ActionableErrorEnvelope, CardLifecycleState, CardRecord, CardStatus, FreezeManifest, HandoffSummary, RuntimeActivationOutcomeSnapshot, RuntimeCommandRecord, RuntimeRunOutcomeSnapshot, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import type { ActivationCompletionOutcome } from '../schemas/index.js';

const TERMINAL_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['done', 'failed', 'cancelled']);

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
    docsRef: 'docs/operator-runbook.md',
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
    ['stopped', 'failed'].includes(currentRun?.result ?? '');
  if (intentStopped || alreadyTerminal) return null;
  return {
    runId: input.runId,
    updates: {
      phase: 'completed',
      runtime_status: 'idle',
      finished_at: input.nowIso,
      result: 'done',
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
      result: 'failed',
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
        result: 'stopped',
      },
    }));
}

export function buildPauseRuntimeStatePatch(pausedAt: string): Partial<RuntimeState> {
  return { status: 'paused', paused: true, paused_at: pausedAt };
}

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
    current_card_id: input.state?.current_card_id ?? null,
    current_agent_session_id: input.state?.current_agent_session_id ?? null,
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
    current_card_id: input.state?.current_card_id ?? null,
    current_agent_session_id: input.state?.current_agent_session_id ?? null,
    queue: [],
    running_processes: [],
    handoff_summaries: input.handoffSummaries,
    schema_version: 1,
    runtime_version: input.runtimeVersion,
  };
}

export function buildResumeFromFreezeRuntimeStatePatch(manifest: FreezeManifest): Partial<RuntimeState> {
  return {
    status: 'idle',
    started_at: manifest.started_at,
    current_card_id: manifest.current_card_id,
    current_agent_session_id: manifest.current_agent_session_id,
    paused: false,
    paused_at: null,
  };
}

export function buildResumeHandoffContext(manifest: FreezeManifest): string | null {
  const handoffSummaries = manifest.handoff_summaries ?? [];
  if (handoffSummaries.length === 0 || !manifest.current_agent_session_id) return null;
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
  if (input.state?.current_card_id !== input.cardId && input.state?.active_card_run?.card_id !== input.cardId) {
    return null;
  }
  return {
    status: 'idle',
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
  };
}

export function planSweptCurrentAgentSessionPatch(input: {
  state: RuntimeState | null;
  sweptSessionIds: Iterable<string>;
}): Partial<RuntimeState> | null {
  const currentSessionId = input.state?.current_agent_session_id ?? null;
  if (!currentSessionId) return null;
  const sweptSet = new Set(input.sweptSessionIds);
  return sweptSet.has(currentSessionId) ? { current_agent_session_id: null } : null;
}

export function buildShutdownRuntimeStatePatch(): Partial<RuntimeState> {
  return {
    status: 'idle',
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    paused: false,
    paused_at: null,
  };
}

export function buildCurrentAgentSessionPatch(sessionId: string | null): Partial<RuntimeState> {
  return { current_agent_session_id: sessionId };
}

export function buildDispatchPausedRuntimeStatePatch(): Partial<RuntimeState> {
  return { status: 'paused' };
}

export interface StartProjectPreconditionDecision {
  error: ActionableErrorEnvelope | null;
  openRootRun: RuntimeRunRecord | null;
  staleRunningIntentWithoutActiveRootRun: boolean;
  retryingTokenBudgetPlanningBlocker: boolean;
  retryingTerminalToolPlanningBlocker: boolean;
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
    retryingTerminalToolPlanningBlocker: false,
    retryingPlanningBlocker: false,
  };
  if (!input.projectCardExists) {
    return {
      ...base,
      error: makeRuntimePreconditionError({
        code: 'runtime_start_project_card_missing',
        message: `Cannot start project runtime because project card '${input.projectCardId}' does not exist.`,
        nextAction: `Create or initialize the root project card with id '${input.projectCardId}', then retry start_project.`,
        currentState: { projectCardId: input.projectCardId },
      }),
    };
  }
  const retryingTokenBudgetPlanningBlocker =
    input.source !== 'runtime' &&
    input.projectCardStatus === 'blocked' &&
    input.blockedPlanning?.resume_reason === 'planner_context_length_exceeded' &&
    input.blockedPlanning?.failure_kind === 'token_budget_exceeded';
  const retryingTerminalToolPlanningBlocker =
    input.source !== 'runtime' &&
    input.projectCardStatus === 'blocked' &&
    input.blockedPlanning?.resume_reason === 'planner_terminal_tool_exhausted' &&
    input.blockedPlanning?.failure_kind === 'planner_contract_terminal_tool_exhausted';
  const retryingPlanningBlocker = retryingTokenBudgetPlanningBlocker || retryingTerminalToolPlanningBlocker;
  const staleRunningIntentWithoutActiveRootRun =
    (input.state.runtime_intent?.status ?? 'stopped') === 'running' &&
    !openRootRun &&
    input.state.status === 'idle' &&
    (input.state.active_card_run ?? null) === null &&
    (input.state.current_card_id ?? null) === null &&
    !input.hasBlockedPlanning;
  const decisionBase = {
    openRootRun,
    staleRunningIntentWithoutActiveRootRun,
    retryingTokenBudgetPlanningBlocker,
    retryingTerminalToolPlanningBlocker,
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
      return { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null };
    case 'reviewer_started': {
      const goalId = (payload.goalId as string | undefined) ?? null;
      const reviewerSessionId = (payload.reviewerSessionId as string | undefined) ?? null;
      const activeCardRun = (payload.activeCardRun ?? null) as RuntimeState['active_card_run'];
      return { current_card_id: goalId, current_agent_session_id: reviewerSessionId, active_card_run: activeCardRun };
    }
    case 'reviewer_finished':
      return { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null };
  }
}

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8';

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
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null },
    });
  }

  const currentCardId = state.current_card_id ?? null;
  if (currentCardId !== null && currentCardStatus !== null && TERMINAL_STATUSES.has(currentCardStatus)) {
    observations.push({
      invariant: 'I2',
      key: currentCardId,
      details: { cardId: currentCardId, cardStatus: currentCardStatus },
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null },
    });
  }

  const runCardId = state.active_card_run?.card_id ?? null;
  if (runCardId !== currentCardId) {
    observations.push({
      invariant: 'I3',
      key: `${currentCardId ?? 'null'}|${runCardId ?? 'null'}`,
      details: { currentCardId, activeRunCardId: runCardId },
      correction: { status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null },
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
    const snapshot = activation.outcome_snapshot ?? null;
    if (activation.status === 'needs_verification' && snapshot?.kind !== 'paused') {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcomeSnapshot: snapshot } });
    }
    if (activation.status === 'completed' && snapshot && (snapshot.kind !== 'completed' || snapshot.outcome !== 'done')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcomeSnapshot: snapshot } });
    }
    if (activation.status === 'failed' && snapshot && (snapshot.kind !== 'completed' || snapshot.outcome !== 'failed')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcomeSnapshot: snapshot } });
    }
    if (activation.status === 'cancelled' && snapshot && (snapshot.kind !== 'completed' || snapshot.outcome !== 'cancelled')) {
      observations.push({ invariant: 'I7', key: activation.activation_id, details: { activationId: activation.activation_id, status: activation.status, outcomeSnapshot: snapshot } });
    }
  }

  for (const run of state.runtime_runs ?? []) {
    const snapshot = run.outcome_snapshot ?? null;
    if (run.result === 'needs_verification' && snapshot?.kind !== 'paused') {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, result: run.result, outcomeSnapshot: snapshot } });
    }
    if (run.result === 'done' && snapshot && (snapshot.kind !== 'completed' || snapshot.result !== 'done')) {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, result: run.result, outcomeSnapshot: snapshot } });
    }
    if (run.result === 'failed' && snapshot && (snapshot.kind !== 'completed' || snapshot.result !== 'failed')) {
      observations.push({ invariant: 'I8', key: run.run_id, details: { runId: run.run_id, result: run.result, outcomeSnapshot: snapshot } });
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
      result,
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
  const outcomeSnapshot = input.projectLifecycle ? runtimeRunOutcomeSnapshotFromLifecycle(input.projectLifecycle) : null;
  if (
    (state.runtime_intent?.status ?? 'stopped') !== 'running' ||
    state.status !== 'idle' ||
    (state.current_card_id ?? null) !== null ||
    (state.active_card_run ?? null) !== null
  ) {
    return null;
  }
  const openRootRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'root' && !run.finished_at);
  if (openRootRuns.length === 0) {
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
        current_card_id: null,
        current_agent_session_id: null,
        active_card_run: null,
        updated_at: nowIso,
      },
      diagnosticMessage: 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.',
    };
  }
  return {
    runUpdates: openRootRuns.map((run) => ({
      runId: run.run_id,
      updates: {
        phase: projectTerminal ? 'completed' : 'failed',
        runtime_status: projectTerminal ? 'idle' : 'error',
        finished_at: nowIso,
        updated_at: nowIso,
        result: projectTerminal ? 'done' : 'failed',
        ...(outcomeSnapshot ? { outcome_snapshot: outcomeSnapshot } : {}),
      },
    })),
    diagnosticMessage: projectTerminal
      ? 'Reconciled running runtime intent to expected idle because the project card is terminal and no active card run exists.'
      : 'Reconciled running runtime intent with open root run while runtime was idle and had no active card run.',
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
  if (latestRootRun?.result === 'failed' || latestRootRun?.runtime_status === 'error' || latestRootRun?.phase === 'failed') {
    return { shouldRedispatch: true, cardId: projectCardId, reason: 'failed_root_run_with_running_intent' };
  }
  return { shouldRedispatch: false };
}

export function activationOutcomeSnapshotFromLifecycle(input: {
  cardId: string;
  lifecycle: CardLifecycleState;
}): RuntimeActivationOutcomeSnapshot | null {
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

export function runtimeRunOutcomeSnapshotFromLifecycle(lifecycle: CardLifecycleState): RuntimeRunOutcomeSnapshot | null {
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
  const activationSnapshot = lifecycle ? activationOutcomeSnapshotFromLifecycle({ cardId: childCardId, lifecycle }) : null;
  const runSnapshot = lifecycle ? runtimeRunOutcomeSnapshotFromLifecycle(lifecycle) : null;
  const runResult: RuntimeRunRecord['result'] =
    outcome === 'done'
      ? 'done'
      : outcome === 'blocked'
        ? 'blocked'
        : outcome === 'cancelled'
          ? 'cancelled'
          : outcome === 'needs_verification'
            ? 'needs_verification'
            : 'failed';
  const transitioningActivations = currentState.runtime_activations.filter(
    (activation) =>
      activation.child_card_id === childCardId &&
      ['pending', 'claimed', 'running'].includes(activation.status),
  );
  const completedActivationIds = new Set(transitioningActivations.map((activation) => activation.activation_id));
  const completedRunIds = new Set(transitioningActivations.map((activation) => activation.runtime_run_id).filter((runId): runId is string => typeof runId === 'string'));
  const activations = currentState.runtime_activations.map((activation) =>
    completedActivationIds.has(activation.activation_id)
      ? { ...activation, status: terminalStatus as typeof activation.status, updated_at: nowIso, ...(activationSnapshot ? { outcome_snapshot: activationSnapshot } : {}) }
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
          result: runResult,
          ...(runSnapshot ? { outcome_snapshot: runSnapshot } : {}),
        }
      : run,
  );
  return {
    ...currentState,
    runtime_activations: activations,
    runtime_runs: runs,
    updated_at: nowIso,
  };
}
