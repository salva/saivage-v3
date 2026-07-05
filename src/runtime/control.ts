import { readRuntimeState } from './state.js';
import type { RuntimeState } from '../schemas/index.js';
import { createRuntimeStateMutationPort } from './mutations.js';
import { pauseRuntimeCommand, resumeRuntimeCommand, type RuntimeControlResult } from './runtime-control-commands.js';

/**
 * Shared runtime-control authority for pause/resume semantics.
 *
 * Accepted semantics:
 * - CLI/analyst paths mutate persisted runtime state through the shared
 *   pause/resume command handler.
 * - stopped/unavailable: if no runtime state exists, controls fail with an
 *   actionable initialization error rather than creating an unsafe shim state.
 */

export interface RuntimeControlContext {
  projectRoot: string;
}

export function pauseRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return pauseRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx.projectRoot));
}

export function resumeRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return resumeRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx.projectRoot));
}

function createPersistedControlEffects(projectRoot: string) {
  const mutations = createRuntimeStateMutationPort(projectRoot);
  return {
    readState: () => readRuntimeState(projectRoot),
    now: () => new Date().toISOString(),
    applyStatePatch: (patch: Partial<RuntimeState>) => mutations.apply({ kind: 'patchRuntimeState', patch }),
  };
}
