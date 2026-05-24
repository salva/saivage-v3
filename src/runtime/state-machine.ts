/**
 * F19 — RuntimeStateMachine
 *
 * Owns runtime-layer status transitions for cards and the RuntimeState
 * lifecycle. See SPEC/v1/review-2026-05/F19-runtime-pinned-failed-card/02-design-r5.md.
 *
 * Step 2 (this file at first landing): observe-only skeleton with the
 * action/event type surface pinned, the constructor deps wired, start/stop
 * scheduling, tick() stamping last_tick_at + I4 monotonicity, and
 * enforceInvariants-gated I1-I3 observation. Decomposition logic for
 * transitionCard / transition is intentionally stubbed until Step 5; Step 3
 * wires the machine into Runtime in observe-only mode.
 */

import type { CardStatus } from '../schemas/types.js';
import type { RuntimeState } from '../schemas/types.js';
import type { CardStore } from '../cards/card-store.js';
import type { ErrorLogger } from '../observability/error-logger.js';

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

export interface RuntimeSchedulerHandle { /* opaque */ }

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
  enforceInvariants: boolean;
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
  private readonly enforceInvariants: boolean;
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
    this.enforceInvariants = deps.enforceInvariants;
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
    } finally {
      this._tickInFlight = false;
    }
  }

  async transition(event: RuntimeStateMachineEvent, payload: Record<string, unknown> = {}): Promise<void> {
    if (event === 'tick') {
      await this.tick();
      return;
    }
    // Step 2 stub: decomposition logic for non-tick events lands in Step 5 / Step 6.
    // Until then, no-op so call sites can be wired observe-only without changing
    // RuntimeState semantics.
    void payload;
  }

  async transitionCard(cardId: string, action: RuntimeCardAction, payload: Record<string, unknown> = {}): Promise<boolean> {
    // Step 2 stub: decomposition lives in Step 5. Observe-only consumers do not
    // call transitionCard yet; tests cover the surface explicitly.
    void cardId;
    void action;
    void payload;
    return true;
  }

  // ── Invariant observation (I1-I3) ────────────────────────────

  private observeInvariants(): void {
    const state = this.readState();
    if (state === null) return;

    // I1: status === 'running' ⇒ active_card_run !== null.
    if (state.status === 'running' && (state.active_card_run ?? null) === null) {
      this.logInvariantOnce('I1', 'global', { status: state.status });
      // Step 4 lands corrective body; Step 2 is observe-only.
    }

    // I2: current_card_id references a card with status ∉ TERMINAL_STATUSES.
    const currentCardId = state.current_card_id ?? null;
    if (currentCardId !== null) {
      let cardStatus: CardStatus | null = null;
      try { cardStatus = this.cardStore.read(currentCardId)?.status ?? null; } catch { cardStatus = null; }
      if (cardStatus !== null && TERMINAL_STATUSES.has(cardStatus)) {
        this.logInvariantOnce('I2', currentCardId, { cardId: currentCardId, cardStatus });
      }
    }

    // I3: active_card_run.card_id === current_card_id, or both null.
    const runCardId = state.active_card_run?.card_id ?? null;
    if (runCardId !== currentCardId) {
      this.logInvariantOnce('I3', `${currentCardId ?? 'null'}|${runCardId ?? 'null'}`, { currentCardId, activeRunCardId: runCardId });
    }
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
