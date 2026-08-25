import type {
  ActorLifecycleContext,
  ActorStartContext,
  ActorTransitionContext,
  CompiledActorState,
  CompiledActorTransition,
} from './types.js';

export class InternalActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalActorError';
  }
}

export class InvalidActorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActorDefinitionError';
  }
}

type TaskResult<Result = unknown> = {
  ok: true;
  result: Result;
} | {
  ok: false;
  error: Error;
};

type Task = {
  promise: Promise<TaskResult>;
  onDone: (result: unknown) => void;
  onFailed: (error: Error) => void;
};

export abstract class BaseActor {
  readonly #initialStateId: string;
  readonly #states: ReadonlyMap<string, CompiledActorState>;
  #currentState: string | undefined;
  #nextEvent: { name: string; sequence: number } | undefined;
  #queuedEventSequence = 0;
  #settledEventSequence = 0;
  #eventSettlementWaiters = new Set<{ sequence: number; resolve: () => void; reject: (error: unknown) => void }>();
  #task: Task | null = null;
  #actorMainRunning = false;
  #mainLoopFailed = false;
  #mainLoopFailure: unknown;

  protected constructor(initialStateId: string, states: ReadonlyMap<string, CompiledActorState>) {
    this.#initialStateId = initialStateId;
    this.#states = states;
  }

  protected abstract onStateEntered(context: ActorLifecycleContext): void;
  protected abstract onTransition(context: ActorTransitionContext): void;
  protected abstract onActorMainFailure(error: unknown): void;
  protected onFatalTaskError(_error: unknown): void {}

  state(): string {
    return this.#currentState!;
  }

  start(): void {
    if (this.#currentState !== undefined) throw new InternalActorError(`Cannot start actor more than once from state "${this.#currentState}"`);
    this.#currentState = this.#initialStateId;
    const context: ActorStartContext = Object.freeze({
      source: null,
      event: null,
      target: this.#initialStateId,
    });
    try { this.onStateEntered(context); } catch (error) { this.onFatalTaskError(error); throw error; }
    this.#ensureActorMain();
  }

  protected sendEvent(name: string): void {
    if (this.#nextEvent !== undefined) {
      throw new InternalActorError(`Actor already has pending event "${this.#nextEvent.name}", cannot send "${name}"`);
    }
    this.#queuedEventSequence++;
    this.#nextEvent = { name, sequence: this.#queuedEventSequence };
  }

  protected parkedSendEvent(name: string): void {
    const currentState = this.#currentState;
    if (currentState === undefined) {
      throw new InternalActorError('Cannot send parked event before actor start');
    }
    if (!this.#states.get(currentState)?.isParked) {
      throw new InternalActorError(`Cannot send parked event from non-parked state "${currentState}"`);
    }
    this.sendEvent(name);
    this.#ensureActorMain();
  }

  protected runTask<Result>(run: () => Promise<Result>, callbacks: Readonly<{ onDone(result: Result): void; onFailed(error: Error): void }>): void {
    const currentState = this.#currentState!;
    if (this.#states.get(currentState)?.isTerminal) {
      throw new InternalActorError(`Cannot start task in terminal state "${currentState}"`);
    }
    if (this.#states.get(currentState)?.isParked) {
      throw new InternalActorError(`Cannot start task in parked state "${currentState}"`);
    }
    if (this.#task !== null) throw new InternalActorError(`Actor already has a task in state "${currentState}"`);
    this.#task = {
      promise: this.#safeTask(run),
      onDone: (result) => callbacks.onDone(result as Result),
      onFailed: callbacks.onFailed,
    };
  }

  protected awaitLifecycleSettlement(): Promise<void> {
    if (this.#mainLoopFailed) return Promise.reject(this.#mainLoopFailure);
    const sequence = this.#queuedEventSequence;
    if (this.#settledEventSequence >= sequence) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#eventSettlementWaiters.add({ sequence, resolve, reject });
    });
  }

  #dispatchEvent(eventName: string): string {
    const currentState = this.#currentState!;
    const stateDef = this.#states.get(currentState)!;

    const transition = stateDef.on.get(eventName);
    if (transition === undefined) return currentState;

    if (transition.targetStateId === currentState && !transition.reenter) return currentState;

    const context: ActorTransitionContext = Object.freeze({
      source: currentState,
      event: eventName,
      target: transition.targetStateId,
      reentered: transition.reenter,
    });
    this.#currentState = transition.targetStateId;
    this.onTransition(context);
    this.onStateEntered(context);

    return transition.targetStateId;
  }

  async #actorMain(): Promise<void> {
    try {
      for (;;) {
        const event = this.#nextEvent;
        if (event !== undefined) {
          this.#nextEvent = undefined;
          try {
            this.#dispatchEvent(event.name);
            this.#settledEventSequence = event.sequence;
          } finally {
            this.#settleLifecycleWaiters();
          }
          continue;
        }

        if (this.#states.get(this.#currentState!)?.isTerminal) {
          return;
        }

        if (this.#states.get(this.#currentState!)?.isParked) {
          return;
        }

        if (this.#task === null) {
          throw new InternalActorError(`Actor stuck in non-terminal state "${this.#currentState!}" with no pending tasks or events`);
        }

        const task = this.#task;
        const result = await task.promise;
        if (this.#task !== task) throw new InternalActorError('Actor task slot changed before callback delivery');
        this.#task = null;

        if (result.ok) task.onDone(result.result);
        else task.onFailed(result.error);
      }
    } catch (error) {
      this.onFatalTaskError(error);
      this.#mainLoopFailed = true;
      this.#mainLoopFailure = error;
      for (const waiter of this.#eventSettlementWaiters) {
        this.#eventSettlementWaiters.delete(waiter);
        waiter.reject(error);
      }
      console.error('BaseActor main loop failed', error);
      try {
        this.onActorMainFailure(error);
      } catch (hookError) {
        console.error('BaseActor main-loop failure hook failed', hookError);
      }
    } finally {
      this.#actorMainRunning = false;
    }
  }

  #settleLifecycleWaiters(): void {
    for (const waiter of this.#eventSettlementWaiters) {
      if (waiter.sequence > this.#settledEventSequence) continue;
      this.#eventSettlementWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  #ensureActorMain(): void {
    if (this.#actorMainRunning || this.#mainLoopFailed) return;
    this.#actorMainRunning = true;
    void this.#actorMain();
  }

  async #safeTask<Result>(run: () => Promise<Result>): Promise<TaskResult<Result>> {
    try {
      return { ok: true, result: await run() };
    } catch (error) {
      this.onFatalTaskError(error);
      return { ok: false, error: error as Error };
    }
  }

}

export function validateCompiledActorTable<Transition extends CompiledActorTransition, State extends CompiledActorState<Transition>>(
  initialStateId: string,
  states: ReadonlyMap<string, State>,
): void {
  if (states.size === 0) throw new InvalidActorDefinitionError('Actor definition must declare at least one state');
  for (const stateName of states.keys()) {
    if (stateName === '') throw new InvalidActorDefinitionError('State names must be non-empty');
  }
  if (!states.has(initialStateId)) {
    throw new InvalidActorDefinitionError(`Initial state "${initialStateId}" does not exist in states`);
  }
  for (const [stateName, state] of states) {
    if (state.isTerminal && state.on.size > 0) {
      throw new InvalidActorDefinitionError(`Terminal state "${stateName}" cannot have transitions`);
    }
    if (state.isTerminal && state.isParked) {
      throw new InvalidActorDefinitionError(`State "${stateName}" cannot be both terminal and parked`);
    }
    for (const [eventName, transition] of state.on) {
      if (eventName === '') {
        throw new InvalidActorDefinitionError(`Event name must be non-empty in state "${stateName}"`);
      }
      if (!states.has(transition.targetStateId)) {
        throw new InvalidActorDefinitionError(`Transition target "${transition.targetStateId}" in state "${stateName}" for event "${eventName}" does not exist in states`);
      }
      if (transition.reenter && transition.targetStateId !== stateName) {
        throw new InvalidActorDefinitionError(`Transition in state "${stateName}" for event "${eventName}" targets "${transition.targetStateId}" with reenter:true; reentry requires the source and target state to match`);
      }
    }
  }
}

