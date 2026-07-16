export class RuntimeStoppedInterruption extends Error {
  readonly code = 'runtime_stopped_interruption';
  constructor() { super('Runtime project execution stopped.'); }
}

export function isRuntimeStoppedInterruption(value: unknown): value is RuntimeStoppedInterruption {
  return value instanceof RuntimeStoppedInterruption;
}

export interface RuntimeContainmentFailure {
  readonly component: string;
}

export class RuntimeContainmentError extends Error {
  readonly code = 'runtime_containment_error';
  readonly failures: readonly RuntimeContainmentFailure[];
  constructor(failures: readonly RuntimeContainmentFailure[]) {
    super(`Runtime containment failed in ${failures.length} component(s).`);
    this.failures = Object.freeze([...failures]);
  }
}

export interface RuntimeStopOperation {
  readonly interruption: RuntimeStoppedInterruption;
  reportContainmentFailure(component: string, error: unknown): void;
}
