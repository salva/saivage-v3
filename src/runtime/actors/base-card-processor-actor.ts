import { BaseActor } from '../micro-actor/index.js';
import type { CardActivationInput, CardActivationOutcome, CardProcessorActor } from './card-actor.js';
import { processorActorId } from './ids.js';
import { saveActorSnapshot } from './snapshots.js';
import type { ProcessorActiveReconstructionRecord } from './active-reconstruction.js';

export type CardProcessorOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;

type PendingActivation = {
  input: CardActivationInput;
  resolve: (outcome: CardProcessorOutcome) => void;
  reject: (error: Error) => void;
};

export abstract class BaseCardProcessorActor extends BaseActor implements CardProcessorActor {
  readonly projectRoot: string;
  readonly cardId: string;
  outcome: CardProcessorOutcome | null = null;
  activeReconstruction: ProcessorActiveReconstructionRecord | null = null;
  #pending: PendingActivation | null = null;
  #activationCounter = 0;

  protected constructor(args: { projectRoot: string; cardId: string }) {
    super();
    this.projectRoot = args.projectRoot;
    this.cardId = args.cardId;
  }

  activate(input: CardActivationInput, _signal?: AbortSignal): Promise<CardProcessorOutcome> {
    if (this.#pending) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' already has a pending activation.`));
    if (!this.canActivateFrom(this.state())) return Promise.reject(new Error(`${this.processorLabel} '${this.cardId}' cannot activate from '${this.state()}'.`));
    return new Promise<CardProcessorOutcome>((resolve, reject) => {
      this.#activationCounter++;
      this.#pending = { input, resolve, reject };
      this.activeReconstruction = {
        schema_version: 1,
        kind: 'processor_activation',
        processor_kind: this.processorKind,
        card_id: this.cardId,
        caller: input.caller,
        activation_counter: this.#activationCounter,
        started_at: new Date().toISOString(),
      };
      this.parkedSendEvent('activate');
    });
  }

  protected runPendingActivation(stateLabel: string, run: (input: CardActivationInput, signal: AbortSignal) => Promise<CardProcessorOutcome>): void {
    const pending = this.#pending;
    if (!pending) throw new Error(`${this.processorLabel} '${this.cardId}' entered ${stateLabel} without activation input.`);
    this.runTask((signal) => run(pending.input, signal), {
      on_done: (outcome) => this.settlePending(pending, outcome, this.transitionEventForOutcome(outcome)),
      on_failed: (error) => this.settlePending(pending, this.activationFailureOutcome(error.message), 'failed'),
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
    saveActorSnapshot(this.projectRoot, this.snapshot());
  }

  protected transitionEventForOutcome(outcome: CardProcessorOutcome): string {
    return outcome.status;
  }

  protected abstract get processorLabel(): string;

  protected abstract get processorKind(): ProcessorActiveReconstructionRecord['processor_kind'];

  protected abstract activationFailureOutcome(error: string): CardProcessorOutcome;

  private canActivateFrom(state: string): boolean {
    return state === 'idle' || state === 'settled';
  }

  private settlePending(pending: PendingActivation, outcome: CardProcessorOutcome, event: string): void {
    this.outcome = outcome;
    this.activeReconstruction = null;
    pending.resolve(outcome);
    this.#pending = null;
    this.sendEvent(event);
  }
}
