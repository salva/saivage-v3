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
  readonly #operations = new Set<Promise<unknown>>();
  readonly #consumers = new Set<Promise<unknown>>();
  readonly #deliveryAcknowledgements: Array<() => void> = [];
  #revoked = false;
  #reason: unknown = new InvocationInterruptedError('Activation operation tracker was revoked.');
  readonly #abandonedRaw = new Set<Promise<unknown>>();
  #failure: unknown;

  run<T>(activationSignal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#revoked) throw this.#reason;
    const signal = AbortSignal.any([activationSignal, this.#controller.signal]);
    let resolveWrapper!: (value: T) => void;
    let rejectWrapper!: (error: unknown) => void;
    const wrapper = new Promise<T>((resolve, reject) => { resolveWrapper = resolve; rejectWrapper = reject; });
    this.#track(this.#operations, wrapper, false);
    let acknowledgeDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { acknowledgeDelivery = resolve; });
    this.#consumers.add(delivery);
    this.#deliveryAcknowledgements.push(() => {
      acknowledgeDelivery();
      this.#consumers.delete(delivery);
    });
    let rawSettled = false;
    const raw = Promise.resolve().then(() => run(signal));
    void raw.finally(() => this.#abandonedRaw.delete(raw)).catch(() => undefined);
    raw.then(
      (value) => { rawSettled = true; if (!signal.aborted) resolveWrapper(value); },
      (error) => { rawSettled = true; if (!signal.aborted) rejectWrapper(error); },
    );
    const onAbort = (): void => {
      if (!rawSettled) this.#abandonedRaw.add(raw);
      rejectWrapper(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void wrapper.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    return wrapper;
  }

  trackConsumer<T>(consume: () => T | Promise<T>): Promise<T> {
    const acknowledge = this.#deliveryAcknowledgements.shift();
    if (!acknowledge) throw new Error('No activation operation is awaiting consumer delivery.');
    let operation: Promise<T>;
    try { operation = Promise.resolve(consume()); } catch (error) { operation = Promise.reject(error); }
    this.#track(this.#consumers, operation, true);
    void operation.finally(acknowledge).catch(() => undefined);
    return operation;
  }

  revoke(reason: unknown): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#reason = reason;
    this.#controller.abort(reason);
  }

  async join(): Promise<InvocationJoinOutcome> {
    if (!this.#revoked) throw new Error('Activation operation tracker must be revoked before join.');
    await Promise.all([...this.#operations, ...this.#consumers].map((operation) => operation.catch(() => undefined)));
    if (this.#failure !== undefined) throw this.#failure;
    await Promise.resolve();
    return this.#abandonedRaw.size === 0 ? { status: 'joined' } : { status: 'external_dependency_abandoned', abandonedCount: this.#abandonedRaw.size };
  }

  pendingCount(): number {
    return this.#operations.size + this.#consumers.size;
  }

  #track(set: Set<Promise<unknown>>, operation: Promise<unknown>, recordFailure: boolean): void {
    set.add(operation);
    if (recordFailure) void operation.catch((error) => { this.#failure ??= error; });
    void operation.finally(() => set.delete(operation)).catch(() => undefined);
  }
}

/** Owns provider-turn admission and all Saivage callbacks caused by those turns. */
export class InvocationLifecycle {
  #turn = 0;
  #current: OwnedInvocationLease | null = null;
  #controller: AbortController | null = null;
  #admissionOpen = true;
  readonly #wrappers = new Set<Promise<unknown>>();
  readonly #consumers = new Set<Promise<unknown>>();
  readonly #deliveryAcknowledgements: Array<() => void> = [];
  readonly #abandonedRaw = new Set<Promise<unknown>>();
  #interruptionReason: unknown = new InvocationInterruptedError('Invocation lifecycle was revoked.');
  #failure: unknown;

  begin(activationSignal: AbortSignal): InvocationLease {
    if (!this.#admissionOpen) throw this.#interruptionReason;
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
    let resolveWrapper!: (value: T) => void;
    let rejectWrapper!: (error: unknown) => void;
    const wrapper = new Promise<T>((resolve, reject) => {
      resolveWrapper = resolve;
      rejectWrapper = reject;
    });
    this.#track(this.#wrappers, wrapper, false);
    let acknowledgeDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { acknowledgeDelivery = resolve; });
    this.#consumers.add(delivery);
    this.#deliveryAcknowledgements.push(() => {
      acknowledgeDelivery();
      this.#consumers.delete(delivery);
    });

    let rawSettled = false;
    let abandoned = false;
    const raw = Promise.resolve().then(() => run(signal));
    void raw.finally(() => this.#abandonedRaw.delete(raw)).catch(() => undefined);
    raw.then(
      (value) => {
        rawSettled = true;
        if (!signal.aborted) resolveWrapper(value);
      },
      (error) => {
        rawSettled = true;
        if (!signal.aborted) rejectWrapper(error);
      },
    );
    const onAbort = (): void => {
      if (!rawSettled && !abandoned) {
        abandoned = true;
        this.#abandonedRaw.add(raw);
      }
      rejectWrapper(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void wrapper.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    return wrapper;
  }

  trackConsumer<T>(consume: () => T | Promise<T>): Promise<T> {
    const acknowledge = this.#deliveryAcknowledgements.shift();
    if (!acknowledge) throw new Error('No provider invocation is awaiting consumer delivery.');
    let result: Promise<T>;
    try {
      result = Promise.resolve(consume());
    } catch (error) {
      result = Promise.reject(error);
    }
    this.#track(this.#consumers, result, true);
    void result.finally(acknowledge).catch(() => undefined);
    return result;
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
    if (!this.#admissionOpen) return;
    this.#admissionOpen = false;
    this.#interruptionReason = reason;
    this.#controller?.abort(reason);
    this.#current = null;
    this.#controller = null;
  }

  async join(): Promise<InvocationJoinOutcome> {
    if (this.#admissionOpen) throw new Error('Invocation lifecycle must be revoked before join.');
    await Promise.all([...this.#wrappers, ...this.#consumers].map((operation) => operation.catch(() => undefined)));
    if (this.#failure !== undefined) throw this.#failure;
    await Promise.resolve();
    return this.#abandonedRaw.size === 0
      ? { status: 'joined' }
      : { status: 'external_dependency_abandoned', abandonedCount: this.#abandonedRaw.size };
  }

  pendingCount(): number {
    return this.#wrappers.size + this.#consumers.size;
  }

  #ownedCurrent(invocation: InvocationLease): OwnedInvocationLease {
    const owned = invocation as OwnedInvocationLease;
    if (owned.owner !== this || this.#current !== invocation) throw this.#interruptionReason;
    return owned;
  }

  #track(set: Set<Promise<unknown>>, operation: Promise<unknown>, recordFailure: boolean): void {
    set.add(operation);
    if (recordFailure) void operation.catch((error) => { this.#failure ??= error; });
    void operation.finally(() => set.delete(operation)).catch(() => undefined);
  }
}
