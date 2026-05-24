/**
 * F19 — RuntimeStateMachine
 *
 * Owns runtime-layer status transitions for cards and the RuntimeState
 * lifecycle. See SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/02-design-r5.md.
 */

import type { CardStatus, RuntimeState } from '../schemas/index.js';
import type { CardStore } from '../cards/index.js';
import { STARTABLE_STATES, RESTARTABLE_STATES } from '../permissions/index.js';
import type { ErrorLogger } from '../observability/index.js';

export type RuntimeCardAction =
  | 'start'
  | 'restart'
  | 'cancel'
  | 'planner_set_status'
  | 'block'
  | 'complete'
  | 'fail'
  | 'executor_finish'
  | 'reviewer_repair_resume'
  | 'crash_recovery_drop_to_backlog';

export type RuntimeStateMachineEvent =
  | 'tick'
  | 'paused'
  | 'resumed'
  | 'goal_exit'
  | 'card_terminated'
  | 'goal_completed'
  | 'reviewer_started'
  | 'reviewer_finished';

export type RuntimeSchedulerHandle = object;

export interface RuntimeScheduler {
  setInterval(handler: () => void, ms: number): RuntimeSchedulerHandle;
  clearInterval(handle: RuntimeSchedulerHandle): void;
}

export const DEFAULT_TICK_INTERVAL_MS = 5000;

const TERMINAL_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['done', 'failed', 'cancelled']);

export interface RuntimeStateMachineDeps {
  cardStore: CardStore;
  readState: () => RuntimeState | null;
  writeState: (changes: Partial<RuntimeState>) => RuntimeState;
  errorLogger: ErrorLogger;
  clock: () => Date;
  scheduler: RuntimeScheduler;
  redispatchGoal: (cardId: string) => void;
  tickIntervalMs?: number;
}

export class RuntimeStateMachine {
  private readonly cardStore: CardStore;
  private readonly readState: () => RuntimeState | null;
  private readonly writeState: (changes: Partial<RuntimeState>) => RuntimeState;
  private readonly errorLogger: ErrorLogger;
  private readonly clock: () => Date;
  private readonly scheduler: RuntimeScheduler;
  private readonly redispatchGoal: (cardId: string) => void;
  private readonly tickIntervalMs: number;

  private _intervalHandle: RuntimeSchedulerHandle | null = null;
  private _tickInFlight = false;
  private _lastTickAt: Date | null = null;
  private _loggedInvariants = new Set<string>();

  constructor(deps: RuntimeStateMachineDeps) {
    this.cardStore = deps.cardStore;
    this.readState = deps.readState;
    this.writeState = deps.writeState;
    this.errorLogger = deps.errorLogger;
    this.clock = deps.clock;
    this.scheduler = deps.scheduler;
    this.redispatchGoal = deps.redispatchGoal;
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  start(): void {
    if (this._intervalHandle !== null) return;
    this._intervalHandle = this.scheduler.setInterval(() => { void this.tick(); }, this.tickIntervalMs);
  }

  stop(): void {
    if (this._intervalHandle === null) return;
    this.scheduler.clearInterval(this._intervalHandle);
    this._intervalHandle = null;
  }

  async requestImmediateTick(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    if (this._tickInFlight) return;
    this._tickInFlight = true;
    try {
      const now = this.clock();
      // I4: monotonic last_tick_at.
      if (this._lastTickAt !== null && now.getTime() < this._lastTickAt.getTime()) {
        this.logInvariantOnce('I4', 'global', { previous: this._lastTickAt.toISOString(), current: now.toISOString() });
      }
      this._lastTickAt = now;
      const iso = now.toISOString();
      this.writeState({ last_tick_at: iso });
      this.observeInvariants();
      this.maybeRedispatchProjectRoot();
    } finally {
      this._tickInFlight = false;
    }
  }

  async transition(event: RuntimeStateMachineEvent, payload: Record<string, unknown> = {}): Promise<void> {
    switch (event) {
      case 'tick':
        await this.tick();
        return;
      case 'paused':
        this.writeState({ status: 'paused', paused: true, paused_at: this.clock().toISOString() });
        return;
      case 'resumed': {
        const state = this.readState();
        this.writeState({ status: state?.active_card_run ? 'running' : 'idle', paused: false, paused_at: null });
        return;
      }
      case 'goal_exit':
      case 'card_terminated':
      case 'goal_completed':
        this.writeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null });
        return;
      case 'reviewer_started': {
        const goalId = (payload.goalId as string | undefined) ?? null;
        const reviewerSessionId = (payload.reviewerSessionId as string | undefined) ?? null;
        const activeCardRun = (payload.activeCardRun ?? null) as RuntimeState['active_card_run'];
        this.writeState({ current_card_id: goalId, current_agent_session_id: reviewerSessionId, active_card_run: activeCardRun });
        return;
      }
      case 'reviewer_finished':
        this.writeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, queue: [], active_card_run: null });
        return;
    }
  }

  async transitionCard(cardId: string, action: RuntimeCardAction, payload: Record<string, unknown> = {}): Promise<boolean> {
    const card = this.cardStore.read(cardId);
    if (!card) {
      this.errorLogger.appendError({
        message: `state_machine_card_not_found (${cardId})`,
        code: 'state_machine_card_not_found',
        cardId,
        action,
      });
      return false;
    }
    const from = card.status;
    const steps = this.decompose(action, from, payload);
    if (steps === null) {
      const code = action === 'planner_set_status'
        ? 'state_machine_planner_status_rejected'
        : 'state_machine_invalid_source_state';
      this.errorLogger.appendError({
        message: `${code} (cardId=${cardId} action=${action} from=${from})`,
        code,
        cardId,
        action,
        fromStatus: from,
        payload,
      });
      return false;
    }
    for (const target of steps) {
      this.cardStore.setStatus(cardId, target);
    }
    return true;
  }

  /**
   * Action × source-state decomposition matrix. Returns the ordered list of
   * target statuses to step through via `cardStore.setStatus`, or `null` to
   * reject the action. An empty array means "no-op accept" (e.g.
   * `reviewer_repair_resume` from `running`).
   *
   * Source of truth: SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/02-design-r5.md §Permission-matrix.
   */
  private decompose(action: RuntimeCardAction, from: CardStatus, payload: Record<string, unknown>): CardStatus[] | null {
    switch (action) {
      case 'start':
        if (!(STARTABLE_STATES as readonly CardStatus[]).includes(from)) return null;
        switch (from) {
          case 'drafting': return ['backlog', 'active', 'running'];
          case 'backlog':  return ['active', 'running'];
          case 'changed':  return ['active', 'running'];
          default: return null;
        }
      case 'restart':
        if (!(RESTARTABLE_STATES as readonly CardStatus[]).includes(from)) return null;
        switch (from) {
          case 'failed':    return ['backlog', 'active', 'running'];
          case 'done':      return ['backlog', 'active', 'running'];
          case 'cancelled': return ['drafting', 'backlog', 'active', 'running'];
          case 'blocked':   return ['backlog', 'active', 'running'];
          case 'changed':   return ['active', 'running'];
          default: return null;
        }
      case 'cancel':
        return this.cardStore.canTransition(from, 'cancelled') ? ['cancelled'] : null;
      case 'planner_set_status': {
        const requested = payload.requestedStatus as CardStatus | undefined;
        if (!requested) return null;
        if (from === requested) return [];
        return this.cardStore.canTransition(from, requested) ? [requested] : null;
      }
      case 'block':
        if (from === 'active') return ['running', 'blocked'];
        if (from === 'running') return ['blocked'];
        return null;
      case 'complete':
        if (from === 'active') return ['running', 'done'];
        if (from === 'running') return ['done'];
        return null;
      case 'fail':
        if (TERMINAL_STATUSES.has(from)) return null;
        switch (from) {
          case 'running': return ['failed'];
          case 'active':  return ['running', 'failed'];
          case 'backlog': return ['active', 'running', 'failed'];
          case 'drafting': return ['backlog', 'active', 'running', 'failed'];
          case 'blocked': return ['running', 'failed'];
          case 'changed': return ['active', 'running', 'failed'];
          default: return null;
        }
      case 'executor_finish': {
        if (from !== 'running') return null;
        const finalStatus = payload.finalStatus as CardStatus | undefined;
        if (finalStatus === 'done') return ['done'];
        if (finalStatus === 'failed') return ['failed'];
        return null;
      }
      case 'reviewer_repair_resume':
        if (from === 'active') return ['running'];
        if (from === 'running') return [];
        return null;
      case 'crash_recovery_drop_to_backlog':
        if (from === 'active') return ['backlog'];
        if (from === 'running') return ['backlog'];
        return null;
      default:
        return null;
    }
  }

  // ── Invariant observation (I1-I3) ────────────────────────────

  private observeInvariants(): void {
    const state = this.readState();
    if (state === null) return;

    // I1: status === 'running' ⇒ active_card_run !== null.
    if (state.status === 'running' && (state.active_card_run ?? null) === null) {
      this.logInvariantOnce('I1', 'global', { status: state.status });
      // Corrective: status was 'running' with no active card run; drop to idle.
      this.writeState({ status: 'idle', current_card_id: null, current_agent_session_id: null });
    }

    // I2: current_card_id references a card with status ∉ TERMINAL_STATUSES.
    const currentCardId = state.current_card_id ?? null;
    if (currentCardId !== null) {
      let cardStatus: CardStatus | null = null;
      try { cardStatus = this.cardStore.read(currentCardId)?.status ?? null; } catch { cardStatus = null; }
      if (cardStatus !== null && TERMINAL_STATUSES.has(cardStatus)) {
        this.logInvariantOnce('I2', currentCardId, { cardId: currentCardId, cardStatus });
        // Corrective: current_card_id points to a terminal card; clear it.
        this.writeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null });
      }
    }

    // I3: active_card_run.card_id === current_card_id, or both null.
    const runCardId = state.active_card_run?.card_id ?? null;
    if (runCardId !== currentCardId) {
      this.logInvariantOnce('I3', `${currentCardId ?? 'null'}|${runCardId ?? 'null'}`, { currentCardId, activeRunCardId: runCardId });
      // Corrective: clear the desync; the next dispatch will repopulate.
      this.writeState({ status: 'idle', current_card_id: null, current_agent_session_id: null, active_card_run: null });
    }
  }

  /**
   * After invariant observation, if the runtime is idle (no active card run)
   * and `runtime_intent.status === 'running'` with an open root run for
   * 'project', schedule a re-dispatch via the injected dependency. The
   * Runtime's existing `_dispatchInFlight` Set is the dedup gate inside
   * `dispatchGoal`, so this method is safe to call on every tick.
   */
  private maybeRedispatchProjectRoot(): void {
    const state = this.readState();
    if (state === null) return;
    if (state.paused) return;
    if (state.status !== 'idle') return;
    if ((state.active_card_run ?? null) !== null) return;
    const intentStatus = state.runtime_intent?.status ?? 'stopped';
    if (intentStatus !== 'running') return;
    const openRootRun = (state.runtime_runs ?? []).find((run) => run.kind === 'root' && run.card_id === 'project' && !run.finished_at);
    if (!openRootRun) return;
    try { this.redispatchGoal('project'); } catch { void 0; }
  }

  private logInvariantOnce(invariant: 'I1' | 'I2' | 'I3' | 'I4', key: string, details: Record<string, unknown>): void {
    const tuple = `${invariant}:${key}`;
    if (this._loggedInvariants.has(tuple)) return;
    this._loggedInvariants.add(tuple);
    this.errorLogger.appendError({
      message: `state_machine_invariant ${invariant} violated (${key})`,
      code: 'state_machine_invariant',
      invariant,
      key,
      ...details,
    });
  }
}
