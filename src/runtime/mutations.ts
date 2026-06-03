import type { ActivationCompletionOutcome, RuntimeState } from '../schemas/index.js';
import { reduceActivationCompletion } from './runtime-core.js';
import { readRuntimeState, saveRuntimeState, updateRuntimeState } from './state.js';

export type RuntimeMutation =
  | { kind: 'patchRuntimeState'; patch: Partial<RuntimeState> }
  | { kind: 'replaceRuntimeState'; state: RuntimeState }
  | { kind: 'completeActivation'; childCardId: string; outcome: ActivationCompletionOutcome; completedAt: string };

export interface RuntimeStateMutationPort {
  apply(mutation: RuntimeMutation): void;
}

export function applyRuntimeMutation(projectRoot: string, mutation: RuntimeMutation): void {
  switch (mutation.kind) {
    case 'patchRuntimeState':
      updateRuntimeState(projectRoot, mutation.patch);
      return;
    case 'replaceRuntimeState':
      saveRuntimeState(projectRoot, mutation.state);
      return;
    case 'completeActivation': {
      const next = reduceActivationCompletion(
        readRuntimeState(projectRoot),
        mutation.childCardId,
        mutation.outcome,
        mutation.completedAt,
      );
      if (next) saveRuntimeState(projectRoot, next);
      return;
    }
  }
}

export function createRuntimeStateMutationPort(projectRoot: string): RuntimeStateMutationPort {
  return {
    apply: (mutation) => applyRuntimeMutation(projectRoot, mutation),
  };
}
