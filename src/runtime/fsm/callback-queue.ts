export type QueuedCallback = () => void | Promise<void>;

export class AsyncCallbackQueue {
  private items: QueuedCallback[] = [];
  private resolvers: (() => void)[] = [];
  private closed = false;

  push(callback: QueuedCallback): void {
    this.items.push(callback);
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async shift(): Promise<QueuedCallback | undefined> {
    while (this.items.length === 0) {
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => {
        this.resolvers.push(resolve);
      });
    }
    if (this.closed) return undefined;

    return this.items.shift()!;
  }

  drain(): QueuedCallback[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }

  close(): void {
    this.closed = true;
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }
}

export async function runCallbackBatch(queue: AsyncCallbackQueue): Promise<number> {
  const first = await queue.shift();
  if (first === undefined) return 0;

  const batch = [first, ...queue.drain()];

  for (const callback of batch) {
    await callback();
  }

  return batch.length;
}

export async function runCallbackPump(queue: AsyncCallbackQueue): Promise<void> {
  for (;;) {
    const count = await runCallbackBatch(queue);
    if (count === 0) return;
  }
}