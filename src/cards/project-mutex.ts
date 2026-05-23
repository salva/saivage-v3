// F13 r5 §"Mutex implementation" — in-process serialising primitive used as the
// outer lock around CardStore mutations. No third-party dependency.

export class ProjectMutex {
  private chain: Promise<void> = Promise.resolve();

  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.chain;
    this.chain = this.chain.then(() => next, () => next);
    await prior;
    return release;
  }
}
