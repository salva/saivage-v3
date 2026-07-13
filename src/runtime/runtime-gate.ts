export class RuntimeGate {
  #open: boolean;
  #terminal = false;
  #terminalReason: unknown;
  #waiters = new Set<{ resolve: () => void; reject: (reason: unknown) => void; signal: AbortSignal; onAbort: () => void }>();

  constructor(open = true) {
    this.#open = open;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  close(): void {
    this.#open = false;
  }

  open(): void {
    if (this.#terminal) throw new Error('Cannot open a terminally closed RuntimeGate.');
    if (this.#open) return;
    this.#open = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
    }
  }

  setOpen(open: boolean): void {
    if (open) this.open();
    else this.close();
  }

  dispose(reason: unknown): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#terminalReason = reason;
    this.#open = false;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.reject(reason);
  }

  waitUntilOpen(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#terminal) return Promise.reject(this.#terminalReason);
    if (this.#open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (reason: unknown) => { cleanup(); reject(reason); },
        signal,
        onAbort: () => waiter.reject(signal.reason),
      };
      const cleanup = (): void => {
        this.#waiters.delete(waiter);
        signal.removeEventListener('abort', waiter.onAbort);
      };
      this.#waiters.add(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }
}
