import type { CardRecord, RuntimeState } from '../schemas/index.js';
import { activeRunFromActivationState } from './activation-reducer.js';
import { commitExecutorInvocationFailure } from './terminal-commit/index.js';

export interface StartupActivationSnapshot {
  run: NonNullable<RuntimeState['active_card_run']>;
}

export function rehydrateStartupActivation(previousState: RuntimeState | null): StartupActivationSnapshot | null {
  const run = previousState?.active_card_run ?? null;
  return run ? { run } : null;
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
  if (!input.run.ownership || !input.run.planner_session_id) throw new Error(`startup repair cannot reconstruct planner run for '${input.run.card_id}' without persisted ownership and planner session.`);
  return {
    ...input.previousState,
    status: 'running',
    active_card_run: activeRunFromActivationState({
      phase: 'planner',
      cardId: input.run.card_id,
      cardType: input.run.card_type,
      ownership: input.run.ownership,
      plannerSessionId: input.plannerSessionId,
      correctionAttempts: input.run.correction_attempts ?? 0,
      callerSessionId: input.run.caller_session_id,
      callerToolCallId: input.run.caller_tool_call_id,
      activeRun: { ...input.run, runtime_status: 'running', reviewer_session_id: null },
    }, input.at),
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
  const activeCardRun = input.parentRun
    ? activeRunFromActivationState({
        phase: 'planner',
        cardId: input.parentRun.card_id,
        cardType: input.parentRun.card_type,
        ownership: input.parentRun.ownership,
        plannerSessionId: requiredPlannerSession(input.parentRun),
        correctionAttempts: input.parentRun.correction_attempts ?? 0,
        callerSessionId: input.parentRun.caller_session_id,
        callerToolCallId: input.parentRun.caller_tool_call_id,
        activeRun: input.parentRun,
      }, input.at)
    : null;
  return {
    ...input.previousState,
    status: activeCardRun ? 'running' : 'idle',
    active_card_run: activeCardRun,
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
  if (!input.run.ownership) throw new Error(`startup repair cannot resume planner run for '${input.run.card_id}' without persisted ownership.`);
  return {
    ...input.previousState,
    status: 'running',
    active_card_run: activeRunFromActivationState({
      phase: 'planner',
      cardId: input.run.card_id,
      cardType: input.run.card_type,
      ownership: input.run.ownership,
      plannerSessionId: requiredPlannerSession(input.run),
      correctionAttempts: input.run.correction_attempts ?? 0,
      callerSessionId: input.run.caller_session_id,
      callerToolCallId: input.run.caller_tool_call_id,
      activeRun: { ...input.run, runtime_status: 'running' },
    }, input.at),
    updated_at: input.at,
    paused: false,
    paused_at: null,
  };
}

function requiredPlannerSession(run: NonNullable<RuntimeState['active_card_run']>): string {
  if (!run.planner_session_id) throw new Error(`startup repair cannot reconstruct planner run for '${run.card_id}' without persisted planner session.`);
  return run.planner_session_id;
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
      const plannerSessionId = requiredPlannerSession(run);
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
        await commitExecutorInvocationFailure({
          card: decision.card,
          goalId: run.planner_session_id?.replace(/^planner:/, '') ?? run.card_id,
          reason: 'service_restart',
          error: 'Execution interrupted by service restart.',
          at: effects.now(),
          effects: {
            transitionCard: (cardId, event, details) => effects.transitionCard(cardId, event as 'fail', details),
            updateCard: (cardId, patch) => effects.repairTerminalLifecycle(cardId, patch),
          },
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
