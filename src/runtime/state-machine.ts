import type { CardRecord, CardStatus, RuntimeState } from '../schemas/index.js';
import { PROJECT_CARD_ID, type CardStore } from '../cards/store-api.js';
import type { ErrorLogger } from '../observability/index.js';
import { planProjectRootRedispatch, observeRuntimeStateInvariants, reduceRuntimeEvent, type RuntimeStateMachineEvent } from './runtime-core.js';
import { deriveCurrentCardId } from './current-run.js';
import { planCardTransition } from './transition-policy.js';
import { cardHasBlockedPlanning } from './planning-blockers.js';
import { readRuntimeState } from './state.js';
import type { RuntimeStateMutationPort } from './mutations.js';

export type RuntimeCardAction =
  | 'start'
  | 'restart'
  | 'cancel'
  | 'planner_set_status'
  | 'block'
  | 'complete'
  | 'fail'
  | 'executor_finish'
  | 'executor_partial_finish'
  | 'reviewer_repair_resume'
  | 'crash_recovery_drop_to_backlog';

export type { RuntimeStateMachineEvent };
export type RuntimeScheduler = RuntimeSchedulerPort;

export interface RuntimeCardPort {
  readStatus(cardId: string): CardStatus | undefined;
  readCard?(cardId: string): Pick<CardRecord, 'status' | 'lifecycle'> | null | undefined;
  canTransition(from: CardStatus, to: CardStatus): boolean;
  setStatus(cardId: string, status: CardStatus): void;
}

export interface RuntimeStatePort {
  read(): RuntimeState | null;
  patch(changes: Partial<RuntimeState>): RuntimeState;
}

export interface RuntimeErrorPort {
  appendError(error: Record<string, unknown>): void;
}

export type RuntimeSchedulerHandle = object;

export interface RuntimeSchedulerPort {
  setInterval(handler: () => void, ms: number): RuntimeSchedulerHandle;
  clearInterval(handle: RuntimeSchedulerHandle): void;
}

export interface RuntimeClockPort {
  now(): Date;
}

export interface RuntimeRedispatchPort {
  redispatch(cardId: string): void;
}

export const DEFAULT_TICK_INTERVAL_MS = 5000;

export interface RuntimeStateMachineDeps {
  cards: RuntimeCardPort;
  state: RuntimeStatePort;
  errors: RuntimeErrorPort;
  clock: RuntimeClockPort;
  scheduler: RuntimeSchedulerPort;
  redispatch: RuntimeRedispatchPort;
  projectCardId?: string;
  tickIntervalMs?: number;
}

export function createRuntimeStateMachine(input: {
  projectRoot: string;
  cards: CardStore;
  errorLogger: ErrorLogger;
  mutations: RuntimeStateMutationPort;
  dispatchGoalThroughScheduler(goalId: string): void;
}): RuntimeStateMachine {
  const scheduler: RuntimeScheduler = {
    setInterval: (handler, ms) => setInterval(handler, ms) as unknown as RuntimeSchedulerHandle,
    clearInterval: (handle) => clearInterval(handle as unknown as NodeJS.Timeout),
  };
  const runtimeCards: RuntimeCardPort = {
    readStatus: (cardId) => input.cards.read(cardId)?.status,
    readCard: (cardId) => input.cards.read(cardId),
    canTransition: (from, to) => input.cards.canTransition(from, to),
    setStatus: (cardId, status) => {
      input.cards.setStatus(cardId, status);
    },
  };
  const runtimeState: RuntimeStatePort = {
    read: () => readRuntimeState(input.projectRoot),
    patch: (changes) => {
      input.mutations.apply({ kind: 'patchRuntimeState', patch: changes });
      const state = readRuntimeState(input.projectRoot);
      if (!state) throw new Error('Runtime state missing after mutation patch.');
      return state;
    },
  };
  return new RuntimeStateMachine({
    cards: runtimeCards,
    state: runtimeState,
    errors: input.errorLogger,
    clock: { now: () => new Date() },
    scheduler,
    redispatch: {
      redispatch: (cardId) => {
        if (!cardHasBlockedPlanning(input.cards.read(cardId)))
          input.dispatchGoalThroughScheduler(cardId);
      },
    },
    projectCardId: PROJECT_CARD_ID,
  });
}

export class RuntimeStateMachine {
  private readonly cards: RuntimeCardPort;
  private readonly state: RuntimeStatePort;
  private readonly errors: RuntimeErrorPort;
  private readonly clock: RuntimeClockPort;
  private readonly scheduler: RuntimeSchedulerPort;
  private readonly redispatch: RuntimeRedispatchPort;
  private readonly projectCardId: string;
  private readonly tickIntervalMs: number;

  private _intervalHandle: RuntimeSchedulerHandle | null = null;
  private _tickInFlight = false;
  private _lastTickAt: Date | null = null;
  private _loggedInvariants = new Set<string>();

  constructor(deps: RuntimeStateMachineDeps) {
    this.cards = deps.cards;
    this.state = deps.state;
    this.errors = deps.errors;
    this.clock = deps.clock;
    this.scheduler = deps.scheduler;
    this.redispatch = deps.redispatch;
    this.projectCardId = deps.projectCardId ?? PROJECT_CARD_ID;
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
      const now = this.clock.now();
      if (this._lastTickAt !== null && now.getTime() < this._lastTickAt.getTime()) {
        this.logInvariantOnce('I4', 'global', { previous: this._lastTickAt.toISOString(), current: now.toISOString() });
      }
      this._lastTickAt = now;
      this.state.patch({ last_tick_at: now.toISOString() });
      this.observeInvariants();
      this.maybeRedispatchProjectRoot();
    } finally {
      this._tickInFlight = false;
    }
  }

  async transition(event: RuntimeStateMachineEvent, payload: Record<string, unknown> = {}): Promise<void> {
    if (event === 'tick') {
      await this.tick();
      return;
    }
    const patch = reduceRuntimeEvent(this.state.read(), event, payload, this.clock.now().toISOString());
    this.state.patch(patch);
  }

  async transitionCard(cardId: string, action: RuntimeCardAction, payload: Record<string, unknown> = {}): Promise<boolean> {
    const from = this.cards.readStatus(cardId);
    if (!from) {
      this.errors.appendError({
        message: `state_machine_card_not_found (${cardId})`,
        code: 'state_machine_card_not_found',
        cardId,
        action,
      });
      return false;
    }

    const plan = planCardTransition({
      action,
      fromStatus: from,
      payload,
      canTransition: (toStatus) => this.cards.canTransition(from, toStatus),
    });
    if (!plan.accepted) {
      this.errors.appendError({
        message: `${plan.code} (cardId=${cardId} action=${action} from=${from})`,
        code: plan.code,
        cardId,
        action,
        fromStatus: from,
        payload,
      });
      return false;
    }

    const lifecycleOwnedActions: RuntimeCardAction[] = ['block', 'complete', 'fail', 'executor_finish', 'executor_partial_finish'];
    if (!lifecycleOwnedActions.includes(action)) for (const target of plan.steps) this.cards.setStatus(cardId, target);
    return true;
  }

  private observeInvariants(): void {
    const state = this.state.read();
    if (state === null) return;

    const currentCardId = deriveCurrentCardId(state);
    let currentCardStatus: Parameters<typeof observeRuntimeStateInvariants>[0]['currentCardStatus'] = null;
    if (currentCardId !== null) {
      try { currentCardStatus = this.cards.readStatus(currentCardId) ?? null; } catch { currentCardStatus = null; }
    }

    for (const observation of observeRuntimeStateInvariants({ state, currentCardStatus, readCard: (cardId) => this.cards.readCard?.(cardId) ?? null })) {
      this.logInvariantOnce(observation.invariant, observation.key, observation.details);
      if (observation.correction) this.state.patch(observation.correction as Partial<RuntimeState>);
    }
  }

  private maybeRedispatchProjectRoot(): void {
    const state = this.state.read();
    if (state === null) return;
    const decision = planProjectRootRedispatch({ state, projectCardId: this.projectCardId });
    if (!decision.shouldRedispatch || !decision.cardId) return;
    try { this.redispatch.redispatch(decision.cardId); } catch { void 0; }
  }

  private logInvariantOnce(invariant: ReturnType<typeof observeRuntimeStateInvariants>[number]['invariant'], key: string, details: Record<string, unknown>): void {
    const tuple = `${invariant}:${key}`;
    if (this._loggedInvariants.has(tuple)) return;
    this._loggedInvariants.add(tuple);
    this.errors.appendError({
      message: `state_machine_invariant ${invariant} violated (${key})`,
      code: 'state_machine_invariant',
      invariant,
      key,
      ...details,
    });
  }
}
