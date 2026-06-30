import type { RuntimeState } from '../schemas/index.js';

export function buildPauseRuntimeStatePatch(): Partial<RuntimeState> {
  return { status: 'paused' };
}

export function buildResumeRuntimeStatePatch(state: RuntimeState | null): Partial<RuntimeState> {
  return { status: state?.active_card_run ? 'running' : 'stopped' };
}
