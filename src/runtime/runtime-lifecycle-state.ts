export interface LifecycleFlags {
  paused: boolean;
  running: boolean;
  shuttingDown: boolean;
  dispatchInFlight: Set<string>;
  dispatchPromises: Map<string, Promise<void>>;
}

export function createLifecycleFlags(): LifecycleFlags {
  return {
    paused: false,
    running: false,
    shuttingDown: false,
    dispatchInFlight: new Set(),
    dispatchPromises: new Map(),
  };
}
