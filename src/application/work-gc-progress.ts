import {
  throwIfPublicationOutcomeUnknown,
  type WorkGcCounters,
  type WorkGcProgress,
  type WorkGcProgressObserver,
  type WorkGcProgressPort,
} from '../contracts/index.js';

/** One timer-free, call-local observer. Absent observers allocate no reporter. */
export function createWorkGcProgress(
  observer?: WorkGcProgressObserver,
  now: () => number = () => performance.now(),
): WorkGcProgressPort | undefined {
  if (!observer) return undefined;
  const start = now();
  let last = -Infinity;
  let phase: WorkGcProgress['phase'];
  const counters: WorkGcCounters = {};
  function emit(force: boolean): void {
    if (!observer) return;
    const time = now();
    if (!force && time - last < 1000) return;
    last = time;
    try {
      observer({ phase, elapsed_ms: Math.floor(time - start), ...counters });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      observer = undefined;
    }
  }
  return {
    phase(next, values) {
      const changed = next !== phase;
      phase = next;
      Object.assign(counters, values);
      emit(changed);
    },
    update(values) { Object.assign(counters, values); emit(false); },
    increment(counter) { counters[counter] = (counters[counter] ?? 0) + 1; emit(false); },
  };
}
