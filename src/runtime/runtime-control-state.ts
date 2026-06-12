import type { RuntimeState } from '../schemas/index.js';

/** Sets the full pause field group: status, paused, and paused_at. */
export function buildPauseRuntimeStatePatch(pausedAt: string): Partial<RuntimeState> {
  return { status: 'paused', paused: true, paused_at: pausedAt };
}

/** Sets the full resume field group: status, paused, and paused_at. */
export function buildResumeRuntimeStatePatch(state: RuntimeState | null): Partial<RuntimeState> {
  return {
    status: state?.active_card_run ? 'running' : 'idle',
    paused: false,
    paused_at: null,
  };
}
