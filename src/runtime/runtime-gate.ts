export class RuntimeGate {
  #open: boolean;
  #waiters: Array<() => void> = [];

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
    if (this.#open) return;
    this.#open = true;
    const waiters = this.#waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  setOpen(open: boolean): void {
    if (open) this.open();
    else this.close();
  }

  waitUntilOpen(): Promise<void> {
    if (this.#open) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}
