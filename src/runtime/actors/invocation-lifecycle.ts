import { ContainedOperations } from './contained-operations.js';

const INVOCATION_LEASE: unique symbol = Symbol('saivage.invocation-lease');

export interface InvocationLease {
  readonly [INVOCATION_LEASE]: true;
}

export class InvocationInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationInterruptedError';
  }
}

type OwnedInvocationLease = InvocationLease & {
  readonly owner: InvocationLifecycle;
  readonly turn: number;
  readonly signal: AbortSignal;
};

export type InvocationJoinOutcome =
  | { status: 'joined' }
  | { status: 'external_dependency_abandoned'; abandonedCount: number };

export class ActivationOperationTracker {
  readonly #controller = new AbortController();
  readonly #operations = new ContainedOperations(new InvocationInterruptedError('Activation operation tracker was revoked.'));

  run<T>(activationSignal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#operations.assertAdmissionOpen();
    const signal = AbortSignal.any([activationSignal, this.#controller.signal]);
    return this.#operations.run(signal, run);
  }

  trackConsumer(consume: () => void | Promise<void>): Promise<void> {
    return this.#operations.consume(consume);
  }

  closeAdmission(reason: unknown): void {
    this.#operations.closeAdmission(reason);
  }

  revoke(reason: unknown): void {
    this.#operations.revoke(reason, this.#controller);
  }

  join(): Promise<InvocationJoinOutcome> {
    return this.#operations.join();
  }

  pendingCount(): number {
    return this.#operations.pendingCount();
  }
}

/** Owns provider-turn admission and all Saivage callbacks caused by those turns. */
export class InvocationLifecycle {
  #turn = 0;
  #current: OwnedInvocationLease | null = null;
  #controller: AbortController | null = null;
  readonly #operations = new ContainedOperations(new InvocationInterruptedError('Invocation lifecycle was revoked.'));

  begin(activationSignal: AbortSignal): InvocationLease {
    this.#operations.assertAdmissionOpen();
    if (this.#current !== null) throw new Error('Cannot begin a provider turn while another invocation is current.');
    const controller = new AbortController();
    const signal = AbortSignal.any([activationSignal, controller.signal]);
    const invocation = Object.freeze({
      [INVOCATION_LEASE]: true as const,
      owner: this,
      turn: ++this.#turn,
      signal,
    });
    this.#controller = controller;
    this.#current = invocation;
    return invocation;
  }

  signal(invocation: InvocationLease): AbortSignal {
    return this.#ownedCurrent(invocation).signal;
  }

  assertCurrent(invocation: InvocationLease): void {
    const owned = this.#ownedCurrent(invocation);
    if (owned.signal.aborted) throw owned.signal.reason;
  }

  runExternal<T>(invocation: InvocationLease, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.signal(invocation);
    return this.#operations.run(signal, run);
  }

  trackConsumer(consume: () => void | Promise<void>): Promise<void> {
    return this.#operations.consume(consume);
  }

  settle(invocation: InvocationLease): void {
    this.assertCurrent(invocation);
    this.#current = null;
    this.#controller = null;
  }

  cancelCurrent(invocation: InvocationLease, reason: unknown): void {
    this.#ownedCurrent(invocation);
    this.#controller?.abort(reason);
    this.#current = null;
    this.#controller = null;
  }

  revoke(reason: unknown): void {
    this.#operations.revoke(reason, this.#controller);
    this.#current = null;
    this.#controller = null;
  }

  closeAdmission(reason: unknown): void {
    this.#operations.closeAdmission(reason);
  }

  join(): Promise<InvocationJoinOutcome> {
    return this.#operations.join();
  }

  pendingCount(): number {
    return this.#operations.pendingCount();
  }

  #ownedCurrent(invocation: InvocationLease): OwnedInvocationLease {
    const owned = invocation as OwnedInvocationLease;
    if (owned.owner !== this || this.#current !== invocation) throw this.#operations.interruptionReason();
    return owned;
  }
}
