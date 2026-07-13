import type { RuntimeState } from '../schemas/index.js';
import type { RuntimeStateStore } from './state.js';
import type { CompositionMutationAuthority } from '../application/mutation-authority.js';
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
  runtimeState: RuntimeStateStore;
  authority: CompositionMutationAuthority;
}

export function pauseRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return pauseRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx));
}

export function resumeRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return resumeRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx));
}

function createPersistedControlEffects(ctx: RuntimeControlContext) {
  return {
    readState: () => ctx.runtimeState.read(),
    now: () => new Date().toISOString(),
    applyStatePatch: (patch: Partial<RuntimeState>) => ctx.runtimeState.patch(ctx.authority, patch),
  };
}
