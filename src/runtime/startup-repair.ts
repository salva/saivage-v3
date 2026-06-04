import type { CardRecord, RuntimeState } from '../schemas/index.js';
import { CardActivation } from './card-activation.js';
import { lifecyclePatch } from './terminal-commit/lifecycle-patch.js';

export interface StartupActivationSnapshot {
  activation: CardActivation;
  run: NonNullable<RuntimeState['active_card_run']>;
}

export function rehydrateStartupActivation(previousState: RuntimeState | null): StartupActivationSnapshot | null {
  const run = previousState?.active_card_run ?? null;
  const activation = CardActivation.fromActiveRun(run);
  return activation && run ? { activation, run } : null;
}

export type StartupActiveRunRepairDecision =
  | { kind: 'repair_orphan_tool_calls'; state: RuntimeState | null }
  | { kind: 'reviewer_interrupted'; run: NonNullable<RuntimeState['active_card_run']> }
  | { kind: 'executor_interrupted'; run: NonNullable<RuntimeState['active_card_run']>; card: CardRecord; shouldFailCard: boolean }
  | { kind: 'terminal_active_card'; run: NonNullable<RuntimeState['active_card_run']> }
  | { kind: 'blocked_planner'; run: NonNullable<RuntimeState['active_card_run']> }
  | { kind: 'resume_planner'; run: NonNullable<RuntimeState['active_card_run']> }
  | { kind: 'clear_active_run' };

export function decideStartupActiveRunRepair(input: {
  previousState: RuntimeState | null;
  card: CardRecord | null | undefined;
  hasPersistedReview: boolean;
  cardHasBlockedPlanning: boolean;
  isTerminalCardStatus: boolean;
}): StartupActiveRunRepairDecision {
  const run = input.previousState?.active_card_run ?? null;
  if (!run) return { kind: 'repair_orphan_tool_calls', state: input.previousState };
  if (!input.card) return { kind: 'repair_orphan_tool_calls', state: input.previousState };
  if (run.phase === 'reviewer' && !input.hasPersistedReview) return { kind: 'reviewer_interrupted', run };
  if (run.phase === 'executor') {
    return {
      kind: 'executor_interrupted',
      run,
      card: input.card,
      shouldFailCard: !input.isTerminalCardStatus,
    };
  }
  if (input.isTerminalCardStatus) return { kind: 'terminal_active_card', run };
  if (run.phase === 'planner') {
    return input.cardHasBlockedPlanning ? { kind: 'blocked_planner', run } : { kind: 'resume_planner', run };
  }
  return { kind: 'clear_active_run' };
}

export function shouldRestartRunningIntentOnStartup(input: {
  state: RuntimeState;
  projectHasBlockedPlanning: boolean;
}): boolean {
  return (
    (input.state.runtime_intent?.status ?? 'stopped') === 'running' &&
    input.state.status === 'idle' &&
    (input.state.current_card_id ?? null) === null &&
    (input.state.active_card_run ?? null) === null &&
    (input.state.runtime_runs ?? []).every((run) => run.kind !== 'root' || Boolean(run.finished_at)) &&
    !input.projectHasBlockedPlanning
  );
}

export function selectStartupPlannerRedispatchCardId(input: {
  state: RuntimeState;
  activeCardHasBlockedPlanning: boolean;
}): string | null {
  const startupActiveRun = input.state.active_card_run;
  if (startupActiveRun?.phase !== 'planner' || startupActiveRun.runtime_status !== 'running') return null;
  return input.activeCardHasBlockedPlanning ? null : startupActiveRun.card_id;
}

export function buildReviewerInterruptedStartupState(input: {
  previousState: RuntimeState;
  run: NonNullable<RuntimeState['active_card_run']>;
  plannerSessionId: string;
  at: string;
}): RuntimeState {
  return {
    ...input.previousState,
    status: 'running',
    current_card_id: input.run.card_id,
    current_agent_session_id: input.plannerSessionId,
    active_card_run: {
      ...input.run,
      phase: 'planner',
      runtime_status: 'running',
      reviewer_session_id: null,
      last_turn_at: input.at,
    },
    updated_at: input.at,
    paused: false,
    paused_at: null,
  };
}

export function buildChildRunStartupState(input: {
  previousState: RuntimeState;
  parentRun: RuntimeState['active_card_run'];
  at: string;
}): RuntimeState {
  return {
    ...input.previousState,
    status: input.parentRun ? 'running' : 'idle',
    current_card_id: input.parentRun?.card_id ?? null,
    current_agent_session_id: input.parentRun?.planner_session_id ?? null,
    active_card_run: input.parentRun,
    updated_at: input.at,
    paused: false,
    paused_at: null,
  };
}

export function buildBlockedPlannerStartupState(input: {
  previousState: RuntimeState;
  at: string;
}): RuntimeState {
  return {
    ...input.previousState,
    status: 'idle',
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    updated_at: input.at,
    paused: false,
    paused_at: null,
  };
}

export function buildResumePlannerStartupState(input: {
  previousState: RuntimeState;
  run: NonNullable<RuntimeState['active_card_run']>;
  at: string;
}): RuntimeState {
  return {
    ...input.previousState,
    status: 'running',
    current_card_id: input.run.card_id,
    current_agent_session_id: input.run.planner_session_id ?? `planner:${input.run.card_id}`,
    active_card_run: { ...input.run, runtime_status: 'running', last_turn_at: input.at },
    updated_at: input.at,
    paused: false,
    paused_at: null,
  };
}

export interface StartupActiveRunRepairEffects {
  now(): string;
  repairOrphanActivateCardToolCalls(): void;
  transitionCard(cardId: string, event: 'reviewer_repair_resume' | 'fail', details: Record<string, unknown>): Promise<unknown>;
  repairTerminalLifecycle(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  appendChildUnwindToolResult(cardId: string, outcome: 'done' | 'failed' | 'cancelled', summary: string): void;
  parentPlannerRunFor(cardId: string): RuntimeState['active_card_run'];
  findCallerEdge(cardId: string): { callerSessionId: string; callerToolCallId: string } | null;
  synthesizeTerminalActivationResult(sessionId: string, toolCallId: string, cardId: string): boolean;
  finishOpenPlannerRun(cardId: string, result: 'blocked' | 'failed'): void;
  queueSyntheticPlannerNote(note: {
    target_planner_session_id: string;
    target_goal_card_id: string;
    kind: 'reviewer_interrupted';
    affected_card_id: string;
    descendant_card_ids: string[];
    summary: string;
  }): void;
  saveState(state: RuntimeState): RuntimeState;
}

export async function executeStartupActiveRunRepairDecision(input: {
  decision: StartupActiveRunRepairDecision;
  previousState: RuntimeState | null;
  effects: StartupActiveRunRepairEffects;
}): Promise<RuntimeState | null> {
  const { decision, effects, previousState } = input;
  switch (decision.kind) {
    case 'repair_orphan_tool_calls':
      effects.repairOrphanActivateCardToolCalls();
      return decision.state;
    case 'reviewer_interrupted': {
      const { run } = decision;
      await effects.transitionCard(run.card_id, 'reviewer_repair_resume', {
        reason: 'reviewer_interrupted',
      });
      const plannerSessionId = run.planner_session_id ?? `planner:${run.card_id}`;
      const summary = `reviewer_interrupted: reviewer output for ${run.card_id} was discarded after service restart; interrupted_reviewer_session_id=${run.reviewer_session_id ?? 'unknown'}; resume_reason: reviewer_interrupted.`;
      effects.queueSyntheticPlannerNote({
        target_planner_session_id: plannerSessionId,
        target_goal_card_id: run.card_id,
        kind: 'reviewer_interrupted',
        affected_card_id: run.card_id,
        descendant_card_ids: [],
        summary,
      });
      return effects.saveState(
        buildReviewerInterruptedStartupState({
          previousState: previousState!,
          run,
          plannerSessionId,
          at: effects.now(),
        }),
      );
    }
    case 'executor_interrupted': {
      const { run } = decision;
      if (decision.shouldFailCard) {
        await effects.transitionCard(run.card_id, 'fail', {
          reason: 'service_restart',
          error: 'Execution interrupted by service restart.',
        });
        await effects.repairTerminalLifecycle(run.card_id, {
          ...lifecyclePatch({
            status: 'failed',
            result: {
              kind: 'executor_failure',
              error: 'Execution interrupted by service restart.',
              partial_result: { failure_kind: 'service_restart' },
              latest_self_report: {
                result: 'failed',
                outcome: 'failed',
                summary: 'Execution interrupted by service restart.',
                status_text: 'Execution interrupted by service restart.',
                at: effects.now(),
              },
            },
            error: 'Execution interrupted by service restart.',
            completed_at: effects.now(),
          }),
          status_text: 'Execution interrupted by service restart.',
        });
      }
      effects.appendChildUnwindToolResult(
        run.card_id,
        'failed',
        `Terminal card ${run.card_id} failed because the service restarted before executor completion.`,
      );
      return effects.saveState(
        buildChildRunStartupState({
          previousState: previousState!,
          parentRun: effects.parentPlannerRunFor(run.card_id),
          at: effects.now(),
        }),
      );
    }
    case 'terminal_active_card': {
      const { run } = decision;
      const edge = effects.findCallerEdge(run.card_id);
      if (edge)
        effects.synthesizeTerminalActivationResult(
          edge.callerSessionId,
          edge.callerToolCallId,
          run.card_id,
        );
      return effects.saveState(
        buildChildRunStartupState({
          previousState: previousState!,
          parentRun: effects.parentPlannerRunFor(run.card_id),
          at: effects.now(),
        }),
      );
    }
    case 'blocked_planner': {
      const { run } = decision;
      effects.finishOpenPlannerRun(run.card_id, 'blocked');
      return effects.saveState(
        buildBlockedPlannerStartupState({ previousState: previousState!, at: effects.now() }),
      );
    }
    case 'resume_planner': {
      const { run } = decision;
      return effects.saveState(
        buildResumePlannerStartupState({ previousState: previousState!, run, at: effects.now() }),
      );
    }
    case 'clear_active_run':
      effects.repairOrphanActivateCardToolCalls();
      return null;
  }
}
