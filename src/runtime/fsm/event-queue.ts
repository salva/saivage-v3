import type { Event } from './types.js';

export type EventHandler = (event: Event) => void;
export type EventErrorHandler = (error: unknown, event: Event) => void;

export class AsyncEventQueue {
  private items: Event[] = [];
  private wake: (() => void) | undefined;

  push(event: Event): void {
    this.items.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  async shift(): Promise<Event> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }

    return this.items.shift()!;
  }

  drain(): Event[] {
    const batch = this.items;
    this.items = [];
    return batch;
  }
}

export async function runEventBatch(
  queue: AsyncEventQueue,
  handleEvent: EventHandler,
  onError: EventErrorHandler,
): Promise<number> {
  const first = await queue.shift();
  const batch = [first, ...queue.drain()];

  for (const event of batch) {
    try {
      const result = handleEvent(event) as unknown;
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        onError(new Error('Actor event handlers must be synchronous'), event);
      }
    } catch (error) {
      onError(error, event);
    }
  }

  return batch.length;
}

export async function runEventPump(
  queue: AsyncEventQueue,
  handleEvent: EventHandler,
  onError: EventErrorHandler,
): Promise<never> {
  for (;;) {
    await runEventBatch(queue, handleEvent, onError);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}
