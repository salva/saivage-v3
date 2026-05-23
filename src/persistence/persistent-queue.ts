import type { ZodType } from 'zod';
import { z } from 'zod';
import { AtomicJsonFile } from './atomic-json-file.js';
import type { LockHandle } from './project-lock.js';
import { ProjectLock } from './project-lock.js';

export interface PersistentQueueOptions {
  version?: number | null;
}

export class PersistentQueue<T> {
  private readonly file: AtomicJsonFile<T[]>;

  constructor(readonly path: string, schema: ZodType<T>, lock: ProjectLock, options: PersistentQueueOptions = {}) {
    this.file = new AtomicJsonFile(path, z.array(schema), lock, options);
  }

  async enqueue(handle: LockHandle, record: T): Promise<void> {
    await this.file.update(handle, (records) => [...records, record]);
  }

  async dequeue(handle: LockHandle): Promise<T | null> {
    let dequeued: T | null = null;
    await this.file.update(handle, (records) => {
      if (records.length === 0) return records;
      const [first, ...rest] = records;
      dequeued = first ?? null;
      return rest;
    });
    return dequeued;
  }

  async drain(handle: LockHandle): Promise<T[]> {
    let drained: T[] = [];
    await this.file.update(handle, (records) => {
      drained = records;
      return [];
    });
    return drained;
  }

  snapshot(): T[] {
    return this.file.read();
  }
}
