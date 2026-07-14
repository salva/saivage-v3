import { BaseActor } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardProcessorActor } from './card-actor.js';
import { processorActorId } from './ids.js';
import type { ActorSnapshotStore } from './snapshots.js';
import type { ProcessorActiveReconstructionRecord } from './active-reconstruction.js';
import { deferred, type Deferred } from './deferred.js';
import { ActivationOperationTracker, type InvocationJoinOutcome } from './invocation-lifecycle.js';

export type CardProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

export abstract class BaseCardProcessorActor extends BaseActor implements CardProcessorActor {
  readonly projectRoot: string;
  readonly cardId: string;
  readonly snapshots: ActorSnapshotStore;
  outcome: CardProcessorOutcome | null = null;
  activeReconstruction: ProcessorActiveReconstructionRecord | null = null;
  #result: Deferred<CardProcessorOutcome> | null = null;
  #activationInput: CardActivationInput | null = null;
  #activationSignal: AbortSignal | null = null;
  #activationCounter = 0;
  #operationTracker: ActivationOperationTracker | null = null;

  protected constructor(args: { projectRoot: string; cardId: string; snapshots: ActorSnapshotStore }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
    this.snapshots = args.snapshots;
  }

  activate(input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
    if (this.#result && this.isActiveState(this.state())) return this.#result.promise;
    if (this.#result) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' already has a pending activation.`));
    if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' cannot activate from '${this.state()}'.`));
    this.beginActivation(input, signal);
    this.parkedSendEvent('activate');
    return this.#result!.promise;
  }

  recoverActive(state: string, input: CardActivationInput, signal: AbortSignal): Promise<CardProcessorOutcome> {
    if (this.#result) return this.#result.promise;
    if (!this.isActiveState(state)) throw new Error(`${this.processorLabel} '${this.cardId}' cannot recover active state '${state}'.`);
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
      on_failed: (error) => { void tracker.trackConsumer(() => this.finishActivation(this.activationFailureOutcome(error.message))); },
    });
  }

  protected override _on_state_changed(_oldState: string | undefined, _newState: string): void {
    this.persist();
  }

  snapshot() {
    return {
      actor_id: this.processorSnapshotId(),
      actor_kind: 'processor' as const,
      state_value: this.state(),
      context: this.processorSnapshotContext(),
      updated_at: new Date().toISOString(),
    };
  }

  protected processorSnapshotId(): string {
    return processorActorId(this.cardId);
  }

  protected processorSnapshotContext(): Record<string, unknown> {
    return { projectRoot: this.projectRoot, cardId: this.cardId, outcome: this.outcome, active_reconstruction: this.activeReconstruction };
  }

  protected persist(): void {
    this.snapshots.save(this.snapshot());
  }

  protected abstract get processorLabel(): string;

  protected abstract get processorKind(): ProcessorActiveReconstructionRecord['processor_kind'];

  protected abstract activationFailureOutcome(error: string): CardProcessorOutcome;

  disposeActivation(reason: unknown): void {
    this.#operationTracker?.revoke(reason);
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

  private beginActivation(input: CardActivationInput, signal: AbortSignal): void {
    this.#activationCounter++;
    this.#activationInput = input;
    this.#activationSignal = signal;
    this.#operationTracker = new ActivationOperationTracker();
    this.#result = deferred<CardProcessorOutcome>();
    this.activeReconstruction = {
      schema_version: 1,
      kind: 'processor_activation',
      processor_kind: this.processorKind,
      card_id: this.cardId,
      caller: input.caller,
      activation_counter: this.#activationCounter,
      started_at: new Date().toISOString(),
    };
  }

  private finishActivation(outcome: CardProcessorOutcome): void {
    this.outcome = outcome;
    this.activeReconstruction = null;
    this.onActivationSettled(outcome);
    this.#result?.resolve(outcome);
    this.#result = null;
    this.#activationInput = null;
    this.#activationSignal = null;
    this.sendEvent(outcome.status);
  }

  private canActivateFrom(state: string): boolean {
    return state === 'idle' || state === 'settled';
  }

  private isActiveState(state: string): boolean {
    return state !== 'idle' && state !== 'settled';
  }
}
