export class RuntimeStoppedInterruption extends Error {
  constructor() { super('Runtime project execution stopped.'); }
}

export function isRuntimeStoppedInterruption(value: unknown): boolean {
  return value instanceof RuntimeStoppedInterruption;
}
