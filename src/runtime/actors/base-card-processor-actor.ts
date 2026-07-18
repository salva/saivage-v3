import { BaseActor } from '../micro-actor/index.js';
import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { CardActivationInput, CardProcessorActor } from './card-actor.js';
import { deferred, type Deferred } from './deferred.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from './invocation-lifecycle.js';
import { isRuntimeStoppedInterruption } from './runtime-stopped-interruption.js';

export type CardProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export abstract class BaseCardProcessorActor extends BaseActor implements CardProcessorActor {
  readonly projectRoot: string;
  readonly cardId: string;
  outcome: CardProcessorOutcome | null = null;
  #result: Deferred<CardProcessorOutcome> | null = null;
  #activationInput: CardActivationInput | null = null;
  #activationSignal: AbortSignal | null = null;
  #operationTracker: ActivationOperationTracker | null = null;

  protected constructor(args: { projectRoot: string; cardId: string }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
  }

  activate(input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
    if (this.#result && this.isActiveState(this.state())) return this.#result.promise;
    if (this.#result) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' already has a pending activation.`));
    if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' cannot activate from '${this.state()}'.`));
    this.beginActivation(input, signal);
    this.parkedSendEvent('activate');
    return this.#result!.promise;
  }

  protected runPendingActivation(stateLabel: string, run: (input: CardActivationInput, signal: AbortSignal) => Promise<CardProcessorOutcome>): void {
    if (!this.#result || !this.#activationInput || !this.#activationSignal) throw new Error(`${this.processorLabel} '${this.cardId}' entered ${stateLabel} without activation input.`);
    const input = this.#activationInput;
    const signal = this.#activationSignal;
    const tracker = this.#operationTracker;
    if (!tracker) throw new Error(`${this.processorLabel} '${this.cardId}' has no activation operation tracker.`);
    this.runTask((taskSignal) => tracker.run(AbortSignal.any([signal, taskSignal]), (operationSignal) => run(input, operationSignal)), {
      on_done: (outcome) => { void tracker.trackConsumer(() => this.finishActivation(outcome)); },
      on_failed: (error) => { void tracker.trackConsumer(() => {
        if (isRuntimeStoppedInterruption(error)) { this.failActivation(error); return; }
        this.finishActivation(this.activationFailureOutcome(error.message));
      }); },
    });
  }

  protected abstract get processorLabel(): string;

  protected abstract activationFailureOutcome(error: string): CardProcessorOutcome;

  disposeActivation(reason: unknown): void {
    this.#operationTracker?.revoke(reason);
  }

  suppressContinuationAndPrepareJoin(reason: unknown): void {
    this.#operationTracker?.closeAdmission(reason);
  }

  async joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const tracker = this.#operationTracker;
    if (!tracker) {
      await this.awaitLifecycleSettlement();
      return [];
    }
    const outcome = await tracker.join();
    await this.awaitLifecycleSettlement();
    return [outcome];
  }

  pendingJoinTaskCount(): number {
    return this.#operationTracker?.pendingCount() ?? 0;
  }

  protected onActivationSettled(_outcome: CardProcessorOutcome): void {
  }

  protected onActivationFailed(_error: Error): void {
  }

  protected hasPendingActivation(): boolean {
    return this.#result !== null;
  }

  private beginActivation(input: CardActivationInput, signal: AbortSignal): void {
    this.#activationInput = input;
    this.#activationSignal = signal;
    this.#operationTracker = new ActivationOperationTracker();
    this.#result = deferred<CardProcessorOutcome>();
  }

  private finishActivation(outcome: CardProcessorOutcome): void {
    this.outcome = outcome;
    this.onActivationSettled(outcome);
    this.#result?.resolve(outcome);
    this.#result = null;
    this.#activationInput = null;
    this.#activationSignal = null;
    this.sendEvent(outcome.status);
  }

  private failActivation(error: Error): void {
    this.onActivationFailed(error);
    this.#result?.reject(error);
    this.#result = null;
    this.#activationInput = null;
    this.#activationSignal = null;
    this.sendEvent('failed');
  }

  private canActivateFrom(state: string): boolean {
    return state === 'idle' || state === 'settled';
  }

  private isActiveState(state: string): boolean {
    return state !== 'idle' && state !== 'settled';
  }
}
