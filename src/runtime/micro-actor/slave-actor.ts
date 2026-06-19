import { BaseActor } from './micro-actor.js';

export type SlaveJobCallbacks<Result = unknown> = {
  on_done?: (result: Result) => void;
  on_failed?: (error: Error) => void;
  on_cancelled?: (error: SlaveJobCancelledError) => void;
};

export type SlaveJob<Load = unknown, Result = unknown> = {
  id: string;
  load: Load;
  callbacks?: SlaveJobCallbacks<Result>;
};

export class SlaveJobCancelledError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = 'SlaveJobCancelledError';
  }
}

// SlaveActor is a helper base for externally-addressable actors. It is not an
// actor definition by itself; subclasses own their states and decide how queued
// jobs map onto state transitions.
export abstract class SlaveActor extends BaseActor {
  static #nextJobId = 1;
  readonly #queuedJobs: Array<SlaveJob<any, any>> = [];
  #jobAvailable: (() => void) | null = null;

  submitJob<Load, Result = unknown>(load: Load, callbacks?: SlaveJobCallbacks<Result>): string {
    const id = `job-${SlaveActor.#nextJobId++}`;
    this.#queuedJobs.push({ id, load, callbacks });
    this.#jobAvailable?.();
    this.#jobAvailable = null;
    return id;
  }

  cancelJob(id: string): boolean {
    if (this.cancelQueuedJob(id)) return true;
    return this.cancelRunningJob(id);
  }

  protected dequeueJob<Load = unknown, Result = unknown>(): SlaveJob<Load, Result> | undefined {
    return this.#queuedJobs.shift() as SlaveJob<Load, Result> | undefined;
  }

  protected hasQueuedJobs(): boolean {
    return this.#queuedJobs.length > 0;
  }

  protected waitForJob(signal: AbortSignal): Promise<void> {
    if (this.hasQueuedJobs()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#jobAvailable = resolve;
      signal.addEventListener('abort', () => {
        if (this.#jobAvailable === resolve) this.#jobAvailable = null;
        reject(signal.reason);
      }, { once: true });
    });
  }

  protected cancelQueuedJob(id: string): boolean {
    const index = this.#queuedJobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const [job] = this.#queuedJobs.splice(index, 1);
    if (job) this.markJobCancelled(job, new SlaveJobCancelledError(id));
    return true;
  }

  protected cancelRunningJob(_id: string): boolean {
    return false;
  }

  protected completeJob<Result>(job: SlaveJob<unknown, Result>, result: Result): void {
    job.callbacks?.on_done?.(result);
  }

  protected failJob(job: SlaveJob, error: Error): void {
    job.callbacks?.on_failed?.(error);
  }

  protected markJobCancelled(job: SlaveJob, error = new SlaveJobCancelledError(job.id)): void {
    if (job.callbacks?.on_cancelled) {
      job.callbacks.on_cancelled(error);
    } else {
      job.callbacks?.on_failed?.(error);
    }
  }
}
