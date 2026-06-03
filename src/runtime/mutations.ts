import type { ActivationCompletionOutcome, RuntimeActivationRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import { reduceActivationCompletion } from './runtime-core.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeRun,
  updateRuntimeState,
  upsertRuntimeActivation,
} from './state.js';

type AppendRuntimeRunInput = Parameters<typeof appendRuntimeRun>[1];
type UpsertRuntimeActivationInput = Parameters<typeof upsertRuntimeActivation>[1];

type VoidRuntimeMutation =
  | { kind: 'patchRuntimeState'; patch: Partial<RuntimeState> }
  | { kind: 'replaceRuntimeState'; state: RuntimeState }
  | { kind: 'completeActivation'; childCardId: string; outcome: ActivationCompletionOutcome; completedAt: string };

type AppendRuntimeRunMutation = { kind: 'appendRuntimeRun'; run: AppendRuntimeRunInput };
type UpdateRuntimeRunMutation = { kind: 'updateRuntimeRun'; runId: string; updates: Partial<RuntimeRunRecord> };
type UpsertRuntimeActivationMutation = { kind: 'upsertRuntimeActivation'; activation: UpsertRuntimeActivationInput };

export type RuntimeMutation =
  | VoidRuntimeMutation
  | AppendRuntimeRunMutation
  | UpdateRuntimeRunMutation
  | UpsertRuntimeActivationMutation;

export type RuntimeMutationResult = void | RuntimeRunRecord | RuntimeActivationRecord | null;

export interface RuntimeStateMutationPort {
  apply(mutation: VoidRuntimeMutation): void;
  apply(mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
  apply(mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
  apply(mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
}

export function applyRuntimeMutation(projectRoot: string, mutation: VoidRuntimeMutation): void;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: RuntimeMutation): RuntimeMutationResult;
export function applyRuntimeMutation(projectRoot: string, mutation: RuntimeMutation): RuntimeMutationResult {
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
    case 'appendRuntimeRun':
      return appendRuntimeRun(projectRoot, mutation.run);
    case 'updateRuntimeRun':
      return updateRuntimeRun(projectRoot, mutation.runId, mutation.updates);
    case 'upsertRuntimeActivation':
      return upsertRuntimeActivation(projectRoot, mutation.activation);
  }
}

export function createRuntimeStateMutationPort(projectRoot: string): RuntimeStateMutationPort {
  return {
    apply: ((mutation: RuntimeMutation) => applyRuntimeMutation(projectRoot, mutation)) as RuntimeStateMutationPort['apply'],
  };
}
