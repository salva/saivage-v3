import type {
  WorkGcProgress,
  WorkGcProgressObserver,
  WorkGcProgressReporter,
} from '../contracts/index.js';

/** One call, no timer or queued observations. Sink failures request ordinary cancellation. */
export function createWorkGcProgress(
  observer: WorkGcProgressObserver | undefined,
  cancel: (error: unknown) => void,
  now: () => number = () => performance.now(),
): WorkGcProgressReporter {
  const started = now();
  let last = -Infinity;
  let snapshot: WorkGcProgress = { phase: 'inventory', elapsed_ms: 0 };
  let failed = false;
  return (update) => {
    const time = now();
    const changed = update.phase !== undefined && update.phase !== snapshot.phase;
    snapshot = { ...snapshot, ...update, elapsed_ms: Math.floor(time - started) };
    if (!observer || failed || (!changed && time - last < 1000)) return;
    last = time;
    try {
      observer({ ...snapshot });
    } catch (error) {
      failed = true;
      cancel(error);
    }
  };
}
