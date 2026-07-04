import { readRuntimeState } from './state.js';
import { queueNotification } from '../notifications/index.js';
import type { RuntimeState } from '../schemas/index.js';
import { createRuntimeStateMutationPort } from './mutations.js';
import { pauseRuntimeCommand, resumeRuntimeCommand, type RuntimeControlResult } from './runtime-control-commands.js';
import type { CardNotification } from './actors/card-actor.js';
import type { NotifyCardResult } from './runtime-api.js';

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
  notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
}

const runtimeControlNotifyCardByRoot = new Map<string, (cardId: string, notification: CardNotification) => NotifyCardResult>();

export function setRuntimeControlNotifyCard(projectRoot: string, notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void {
  if (notifyCard) runtimeControlNotifyCardByRoot.set(projectRoot, notifyCard);
  else runtimeControlNotifyCardByRoot.delete(projectRoot);
}

export function pauseRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return pauseRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx.projectRoot, ctx.notifyCard ?? runtimeControlNotifyCardByRoot.get(ctx.projectRoot)));
}

export function resumeRuntimeControl(ctx: RuntimeControlContext): RuntimeControlResult {
  return resumeRuntimeCommand(ctx.projectRoot, createPersistedControlEffects(ctx.projectRoot, ctx.notifyCard ?? runtimeControlNotifyCardByRoot.get(ctx.projectRoot)));
}

function createPersistedControlEffects(projectRoot: string, notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult) {
  const mutations = createRuntimeStateMutationPort(projectRoot);
  return {
    readState: () => readRuntimeState(projectRoot),
    now: () => new Date().toISOString(),
    applyStatePatch: (patch: Partial<RuntimeState>) => mutations.apply({ kind: 'patchRuntimeState', patch }),
    sendNotification: (message: string) => queueNotification(projectRoot, { kind: 'role', role: 'planner' }, 'runtime_state', message, { actor: 'runtime', surface: 'runtime' }, undefined, notifyCard),
  };
}
