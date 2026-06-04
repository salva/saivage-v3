import type { ActivationCompletionOutcome, CardLifecycleState, RuntimeActivationRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import { reduceActivationCompletion } from './runtime-core.js';
import {
  appendRuntimeCommand,
  appendRuntimeRun,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeRun,
  updateRuntimeState,
  upsertRuntimeIntent,
  upsertRuntimeActivation,
} from './state.js';

type AppendRuntimeCommandArgs = Parameters<typeof appendRuntimeCommand>;
type AppendRuntimeRunInput = Parameters<typeof appendRuntimeRun>[1];
type UpsertRuntimeIntentArgs = Parameters<typeof upsertRuntimeIntent>;
type UpsertRuntimeActivationInput = Parameters<typeof upsertRuntimeActivation>[1];

type VoidRuntimeMutation =
  | { kind: 'patchRuntimeState'; patch: Partial<RuntimeState> }
  | { kind: 'replaceRuntimeState'; state: RuntimeState }
  | { kind: 'completeActivation'; childCardId: string; outcome: ActivationCompletionOutcome; completedAt: string; lifecycle?: CardLifecycleState | null };

type AppendRuntimeRunMutation = { kind: 'appendRuntimeRun'; run: AppendRuntimeRunInput };
type UpdateRuntimeRunMutation = { kind: 'updateRuntimeRun'; runId: string; updates: Partial<RuntimeRunRecord> };
type AppendRuntimeCommandMutation = { kind: 'appendRuntimeCommand'; commandKind: AppendRuntimeCommandArgs[1]; source: AppendRuntimeCommandArgs[2] };
type UpsertRuntimeIntentMutation = { kind: 'upsertRuntimeIntent'; status: UpsertRuntimeIntentArgs[1]; sourceCommandId: UpsertRuntimeIntentArgs[2]; reason?: UpsertRuntimeIntentArgs[3] };
type UpsertRuntimeActivationMutation = { kind: 'upsertRuntimeActivation'; activation: UpsertRuntimeActivationInput };

export type RuntimeMutation =
  | VoidRuntimeMutation
  | AppendRuntimeRunMutation
  | UpdateRuntimeRunMutation
  | AppendRuntimeCommandMutation
  | UpsertRuntimeIntentMutation
  | UpsertRuntimeActivationMutation;

export type RuntimeMutationResult = void | RuntimeCommandRecord | RuntimeRunRecord | RuntimeActivationRecord | RuntimeState | null;

export interface RuntimeStateMutationPort {
  apply(mutation: VoidRuntimeMutation): void;
  apply(mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
  apply(mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
  apply(mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: UpsertRuntimeIntentMutation): RuntimeState;
  apply(mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
}

export function applyRuntimeMutation(projectRoot: string, mutation: VoidRuntimeMutation): void;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpsertRuntimeIntentMutation): RuntimeState;
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
        mutation.lifecycle ?? null,
      );
      if (next) saveRuntimeState(projectRoot, next);
      return;
    }
    case 'appendRuntimeRun':
      return appendRuntimeRun(projectRoot, mutation.run);
    case 'updateRuntimeRun':
      return updateRuntimeRun(projectRoot, mutation.runId, mutation.updates);
    case 'appendRuntimeCommand':
      return appendRuntimeCommand(projectRoot, mutation.commandKind, mutation.source);
    case 'upsertRuntimeIntent':
      return upsertRuntimeIntent(projectRoot, mutation.status, mutation.sourceCommandId, mutation.reason);
    case 'upsertRuntimeActivation':
      return upsertRuntimeActivation(projectRoot, mutation.activation);
  }
}

export function createRuntimeStateMutationPort(projectRoot: string): RuntimeStateMutationPort {
  return {
    apply: ((mutation: RuntimeMutation) => applyRuntimeMutation(projectRoot, mutation)) as RuntimeStateMutationPort['apply'],
  };
}
