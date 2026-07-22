export class ContainedOperations {
  readonly #operations = new Set<Promise<unknown>>();
  readonly #consumers = new Set<Promise<unknown>>();
  readonly #deliveryAcknowledgements: Array<() => void> = [];
  readonly #abandonedRaw = new Set<Promise<unknown>>();
  #admissionOpen = true;
  #reason: unknown;
  #failure: unknown;

  constructor(defaultReason: unknown) {
    this.#reason = defaultReason;
  }

  assertAdmissionOpen(): void {
    if (!this.#admissionOpen) throw this.#reason;
  }

  interruptionReason(): unknown {
    return this.#reason;
  }

  run<OperationResult>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<OperationResult>,
  ): Promise<OperationResult> {
    let resolveWrapper!: (value: OperationResult) => void;
    let rejectWrapper!: (error: unknown) => void;
    const wrapper = new Promise<OperationResult>((resolve, reject) => {
      resolveWrapper = resolve;
      rejectWrapper = reject;
    });
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
      if (!rawSettled) this.#abandonedRaw.add(raw);
      rejectWrapper(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void wrapper.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined);
    return wrapper;
  }

  consume<ConsumerResult>(consume: () => ConsumerResult | Promise<ConsumerResult>): Promise<ConsumerResult> {
    const acknowledge = this.#deliveryAcknowledgements.shift();
    if (!acknowledge) throw new Error('No contained operation is awaiting consumer delivery.');
    let result: Promise<ConsumerResult>;
    try {
      result = Promise.resolve(consume());
    } catch (error) {
      result = Promise.reject(error);
    }
    this.#track(this.#consumers, result, true);
    void result.finally(acknowledge).catch(() => undefined);
    return result;
  }

  closeAdmission(reason: unknown): void {
    if (!this.#admissionOpen) return;
    this.#admissionOpen = false;
    this.#reason = reason;
  }

  revoke(reason: unknown, controller: AbortController | null): void {
    this.closeAdmission(reason);
    if (controller && !controller.signal.aborted) controller.abort(this.#reason);
  }

  async join(): Promise<
    | { status: 'joined' }
    | { status: 'external_dependency_abandoned'; abandonedCount: number }
  > {
    if (this.#admissionOpen) throw new Error('Contained operation admission must be closed before join.');
    await Promise.all([...this.#operations, ...this.#consumers].map((operation) => operation.catch(() => undefined)));
    if (this.#failure !== undefined) throw this.#failure;
    await Promise.resolve();
    return this.#abandonedRaw.size === 0
      ? { status: 'joined' }
      : { status: 'external_dependency_abandoned', abandonedCount: this.#abandonedRaw.size };
  }

  #track(set: Set<Promise<unknown>>, operation: Promise<unknown>, recordFailure: boolean): void {
    set.add(operation);
    if (recordFailure) void operation.catch((error) => { this.#failure ??= error; });
    void operation.finally(() => set.delete(operation)).catch(() => undefined);
  }
}
