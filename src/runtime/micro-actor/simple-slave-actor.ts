import { SlaveActor, SlaveJobCancelledError, type SlaveJob } from './slave-actor.js';
import type { ActorDefinition } from './types.js';

type RunningJob = SlaveJob<unknown, unknown> & {
  cancel(): void;
};

// SimpleSlaveActor is a serial worker. It waits for submitted jobs in `waiting`,
// then runs exactly one job in `running` before returning to `waiting`.
export abstract class SimpleSlaveActor<Load = unknown> extends SlaveActor {
  static _actor: ActorDefinition = {
    initial: 'waiting',
    states: {
      waiting: { on: { done: 'running' } },
      running: { on: { done: 'waiting' } },
    },
  };

  #runningJob: RunningJob | null = null;
  #nextJob: SlaveJob<Load> | null = null;

  protected abstract runJob(job: { id: string; load: Load }, context: { signal: AbortSignal }): Promise<unknown>;

  protected override cancelRunningJob(id: string): boolean {
    if (this.#runningJob?.id !== id) return false;
    this.#runningJob.cancel();
    return true;
  }

  _on_enter__waiting(): void {
    this.runTask(
      (signal) => this.dequeueJob<Load>(signal),
      {
        on_done: (job) => {
          this.#nextJob = job;
          this.sendEvent('done');
        },
      },
    );
  }

  _on_enter__running(): void {
    if (this.#runningJob) return;
    const job = this.#nextJob;
    this.#nextJob = null;
    if (!job) {
      this.sendEvent('done');
      return;
    }

    const controller = new AbortController();
    let cancel!: () => void;
    this.runTask(
      (signal) => {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => {
            const error = new SlaveJobCancelledError(job.id);
            controller.abort(error);
            reject(error);
          };
        });
        return Promise.race([
          this.runJob({ id: job.id, load: job.load }, { signal: controller.signal }),
          cancelled,
        ]);
      },
      {
        on_done: (result) => {
          const running = this.#runningJob;
          if (running?.id !== job.id) return;
          this.#runningJob = null;
          this.completeJob(running, result);
          this.sendEvent('done');
        },
        on_failed: (error) => {
          const running = this.#runningJob;
          if (running?.id !== job.id) return;
          this.#runningJob = null;
          if (error instanceof SlaveJobCancelledError) {
            this.markJobCancelled(running, error);
          } else {
            this.failJob(running, error);
          }
          this.sendEvent('done');
        },
      },
    );

    this.#runningJob = { ...job, cancel };
  }
}
