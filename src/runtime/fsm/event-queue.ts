import type { ActorMessage } from './types.js';

export type ActorMessageHandler = (message: ActorMessage) => void;
export type ActorMessageErrorHandler = (error: unknown, message: ActorMessage) => void;

export class AsyncActorQueue {
  private items: ActorMessage[] = [];
  private wake: (() => void) | undefined;

  push(message: ActorMessage): void {
    this.items.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<ActorMessage> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): ActorMessage[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

export async function runActorBatch(
  queue: AsyncActorQueue,
  handleMessage: ActorMessageHandler,
  onError: ActorMessageErrorHandler,
): Promise<number> {
  const first = await queue.shift();
  const batch = [first, ...queue.drain()];

  for (const message of batch) {
    try {
      const result = handleMessage(message) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        onError(new Error('Actor message handlers must be synchronous'), message);
      }
    } catch (error) {
      onError(error, message);
    }
  }

  return batch.length;
}

export async function runActorPump(
  queue: AsyncActorQueue,
  handleMessage: ActorMessageHandler,
  onError: ActorMessageErrorHandler,
): Promise<never> {
  for (;;) {
    await runActorBatch(queue, handleMessage, onError);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
