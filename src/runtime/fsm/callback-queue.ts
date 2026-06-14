export type QueuedCallback = () => void | Promise<void>;

export class AsyncCallbackQueue {
  private items: QueuedCallback[] = [];
  private wake: (() => void) | undefined;

  push(callback: QueuedCallback): void {
    this.items.push(callback);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<QueuedCallback> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): QueuedCallback[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

export async function runCallbackBatch(queue: AsyncCallbackQueue): Promise<number> {
  const first = await queue.shift();
  const batch = [first, ...queue.drain()];

  for (const callback of batch) {
    await callback();
  }

  return batch.length;
}

export async function runCallbackPump(queue: AsyncCallbackQueue): Promise<never> {
  for (;;) {
    await runCallbackBatch(queue);
  }
}
