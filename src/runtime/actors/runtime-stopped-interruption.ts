export class RuntimeStoppedInterruption extends Error {
  readonly code = 'runtime_stopped_interruption';
  constructor() { super('Runtime project execution stopped.'); }
}

export function isRuntimeStoppedInterruption(value: unknown): value is RuntimeStoppedInterruption {
  return value instanceof RuntimeStoppedInterruption;
}
