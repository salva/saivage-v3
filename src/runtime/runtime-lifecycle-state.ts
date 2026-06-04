export interface LifecycleFlags {
  paused: boolean;
  running: boolean;
  shuttingDown: boolean;
  startupRepairPending: boolean;
  resumeHandoffContext: string | null;
  runningProcesses: Set<string>;
  dispatchInFlight: Set<string>;
}

export function createLifecycleFlags(): LifecycleFlags {
  return {
    paused: false,
    running: false,
    shuttingDown: false,
    startupRepairPending: false,
    resumeHandoffContext: null,
    runningProcesses: new Set(),
    dispatchInFlight: new Set(),
  };
}

export function consumeResumeHandoffContext(flags: LifecycleFlags): string | null {
  const ctx = flags.resumeHandoffContext;
  flags.resumeHandoffContext = null;
  return ctx;
}
