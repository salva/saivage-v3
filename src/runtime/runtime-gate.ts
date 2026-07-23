export class RuntimeGate {
  #open: boolean;
  #pauseRequested = false;
  #parked: { resolve: () => void; reject: (reason: unknown) => void; signal: AbortSignal; onAbort: () => void } | null = null;
  #onParked: (() => void) | null = null;

  constructor(open = true) {
    this.#open = open;
  }

  get isOpen(): boolean {
    return this.#open && !this.#pauseRequested;
  }

  completeRun(): void {
    if (this.#parked) throw new Error('Cannot complete a RuntimeGate with a parked frontier.');
    this.#open = false;
    this.#pauseRequested = false;
    this.#onParked = null;
  }

  requestPause(onParked: () => void): void {
    this.#pauseRequested = true;
    this.#open = false;
    this.#onParked = onParked;
  }

  close(): void {
    this.#open = false;
  }

  open(): void {
    this.#pauseRequested = false;
    if (this.#open && !this.#parked) return;
    this.#open = true;
    const parked = this.#parked;
    this.#parked = null;
    this.#onParked = null;
    if (parked) { parked.signal.removeEventListener('abort', parked.onAbort); parked.resolve(); }
  }

  waitUntilOpen(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.isOpen) return Promise.resolve();
    if (this.#parked) throw new Error('RuntimeGate supports exactly one parked frontier.');
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (reason: unknown) => { cleanup(); reject(reason); },
        signal,
        onAbort: () => waiter.reject(signal.reason),
      };
      const cleanup = (): void => {
        if (this.#parked === waiter) this.#parked = null;
        signal.removeEventListener('abort', waiter.onAbort);
      };
      this.#parked = waiter;
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.#onParked?.();
    });
  }
}
