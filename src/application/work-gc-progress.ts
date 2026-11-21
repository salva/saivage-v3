import {
  throwIfPublicationOutcomeUnknown,
  type WorkGcCounters,
  type WorkGcProgressUpdate,
  type WorkGcProgress,
  type WorkGcProgressObserver,
  type WorkGcProgressPort,
  type WorkGcActiveStatus,
} from '../contracts/index.js';

const defaultStep = {
  inventory: 'enumerating',
  settling: 'waiting_for_hold',
  retention_marking: 'operational_inputs',
  selection: 'classifying',
} as const;
const monotonicTime = () => performance.now();

interface Observation {
  phase: WorkGcActiveStatus['phase'];
  substep: WorkGcActiveStatus['substep'];
  stepStart: number;
  checkpoint: number;
  referenceVisits?: number;
}

/** One timer-free, stream-only observer. Absent observers allocate no reporter. */
export function createWorkGcProgress(
  observer?: WorkGcProgressObserver,
  now: () => number = monotonicTime,
): WorkGcProgressPort | undefined {
  if (!observer) return undefined;
  return createReporter(observer, now, now()).progress;
}

export function createObservedWorkGcProgress(
  mode: WorkGcActiveStatus['mode'],
  observer?: WorkGcProgressObserver,
  now: () => number = monotonicTime,
): { progress: WorkGcProgressPort; read: () => WorkGcActiveStatus } {
  const start = now();
  const observation: Observation = {
    phase: 'inventory',
    substep: 'starting',
    stepStart: start,
    checkpoint: start,
  };
  const { progress, counters, firstMark } = createReporter(observer, now, start, observation);
  return {
    progress,
    read: () => {
      const { phase, substep, stepStart, checkpoint, referenceVisits } = observation;
      const time = now();
      const mark = firstMark();
      return {
        mode,
        phase,
        substep,
        elapsed_ms: Math.floor(time - start),
        step_elapsed_ms: Math.floor(time - stepStart),
        last_checkpoint_elapsed_ms: Math.floor(checkpoint - start),
        counters: {
          ...counters,
          ...(referenceVisits === undefined ? {} : { reference_visits: referenceVisits }),
        },
        first_global_protection: mark && { ...mark },
      };
    },
  };
}

function createReporter(
  observer: WorkGcProgressObserver | undefined,
  now: () => number,
  start: number,
  observation?: Observation,
) {
  let last = -Infinity;
  // The reservation is visible without an initial POST frame.
  let phase: WorkGcProgress['phase'] | undefined;
  const counters: WorkGcCounters = {};
  let firstGlobalProtection: WorkGcProgress['first_global_protection'] = null;
  function update(values?: WorkGcProgressUpdate): void {
    if (!values) return;
    const { first_global_protection, ...counts } = values;
    Object.assign(counters, counts);
    if (firstGlobalProtection === null && first_global_protection !== undefined)
      firstGlobalProtection = first_global_protection;
  }
  function emit(force: boolean, time: number): void {
    if (!observer) return;
    if (!force && time - last < 1000) return;
    last = time;
    try {
      observer({
        phase: phase!,
        elapsed_ms: Math.floor(time - start),
        ...counters,
        first_global_protection: firstGlobalProtection,
      });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      observer = undefined;
    }
  }
  const progress: WorkGcProgressPort = {
    phase(next, values) {
      const changed = next !== phase;
      phase = next;
      update(values);
      if (!observation && !observer) return;
      const time = now();
      if (observation) {
        if (changed) {
          observation.phase = next;
          observation.stepStart = time;
          observation.substep = defaultStep[next];
        }
        if (changed || values) observation.checkpoint = time;
      }
      emit(changed, time);
    },
    update(values) {
      update(values);
      checkpointAndEmit();
    },
    increment(counter) {
      counters[counter] = (counters[counter] ?? 0) + 1;
      checkpointAndEmit();
    },
  };
  function checkpointAndEmit(): void {
    if (!observation && !observer) return;
    const time = now();
    if (observation) observation.checkpoint = time;
    emit(false, time);
  }
  if (observation) {
    progress.retentionSource = (step) => {
      const time = now();
      if (step !== observation.substep) {
        observation.substep = step;
        observation.stepStart = time;
      }
      observation.checkpoint = time;
    };
    progress.referenceVisits = (total) => {
      observation.referenceVisits = total;
      observation.checkpoint = now();
    };
  }
  return { progress, counters, firstMark: () => firstGlobalProtection };
}
