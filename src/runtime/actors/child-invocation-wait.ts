import type { CardActivationOutcome } from '../../contracts/tool-api.js';
import type { StructuralChildRelationship, ToolInvocationIdentity } from './executing-llm-snapshot.js';
import { deferred, type Deferred } from './deferred.js';

export type ChildInvocationLeasePhase =
  | 'reserved'
  | 'admitted'
  | 'settling'
  | 'interrupted'
  | 'released'
  | 'rejected';

/** One invocation-local child reservation. Supervisor ownership remains authoritative. */
export class ChildInvocationLease {
  readonly identity: ToolInvocationIdentity;
  readonly childCardId: string;
  readonly relationship: StructuralChildRelationship;
  readonly activation: Promise<CardActivationOutcome>;
  #activation: Deferred<CardActivationOutcome>;
  #phase: ChildInvocationLeasePhase = 'reserved';
  #delivered = false;

  constructor(identity: ToolInvocationIdentity, childCardId: string) {
    if (childCardId.length === 0) throw new Error('Child invocation reservation requires a child card id.');
    this.identity = Object.freeze({ ...identity });
    this.childCardId = childCardId;
    this.relationship = Object.freeze({ ...this.identity, childCardId });
    this.#activation = deferred<CardActivationOutcome>();
    this.activation = this.#activation.promise;
  }

  phase(): ChildInvocationLeasePhase { return this.#phase; }

  markAdmitted(): void { this.transition('reserved', 'admitted'); }
  markSettling(): void { this.transition('admitted', 'settling'); }
  interrupt(reason: Error): void {
    if ((this.#phase !== 'admitted' && this.#phase !== 'settling') || this.#delivered) throw this.invalidTransition('interrupted');
    this.#phase = 'interrupted';
    this.#delivered = true;
    this.#activation.reject(reason);
  }
  markReleased(): void {
    if (this.#phase !== 'settling') throw this.invalidTransition('released');
    this.#phase = 'released';
  }
  markRejected(): void { this.transition('reserved', 'rejected'); }

  deliverOutcome(outcome: CardActivationOutcome): void {
    if (this.#phase !== 'released' || this.#delivered) throw new Error(`Child invocation lease for '${this.childCardId}' cannot deliver an outcome from '${this.#phase}'.`);
    this.#delivered = true;
    this.#activation.resolve(outcome);
  }

  deliverInterruption(reason: Error): void {
    if (this.#phase !== 'rejected' || this.#delivered) throw new Error(`Child invocation lease for '${this.childCardId}' cannot deliver an interruption from '${this.#phase}'.`);
    this.#delivered = true;
    this.#activation.reject(reason);
  }

  async join(): Promise<void> {
    await this.activation.then(() => undefined, () => undefined);
  }

  isWaitingBarrier(): boolean {
    return this.#phase === 'admitted' || this.#phase === 'settling';
  }

  isConsumable(): boolean { return this.#phase === 'released' || this.#phase === 'rejected' || this.#phase === 'interrupted'; }

  private transition(from: ChildInvocationLeasePhase, to: ChildInvocationLeasePhase): void {
    if (this.#phase !== from) throw this.invalidTransition(to);
    this.#phase = to;
  }

  private invalidTransition(to: ChildInvocationLeasePhase): Error {
    return new Error(`Child invocation lease for '${this.childCardId}' cannot transition from '${this.#phase}' to '${to}'.`);
  }
}
