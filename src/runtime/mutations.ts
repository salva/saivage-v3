import type { ActionableErrorEnvelope, ActivationCompletionOutcome, CardLifecycleState, RuntimeActivationRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import { buildCompletedRuntimeCommandState, buildRejectedRuntimeCommandState, reduceActivationCompletion } from './runtime-core.js';
import {
  appendRuntimeCommand,
  appendRuntimeRun,
  updateRuntimeRun,
  updateRuntimeState,
  updateRuntimeStateLockedDeriving,
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
type RejectRuntimeCommandMutation = { kind: 'rejectRuntimeCommand'; command: RuntimeCommandRecord; error: ActionableErrorEnvelope; at: string };
type CompleteRuntimeCommandMutation = { kind: 'completeRuntimeCommand'; command: RuntimeCommandRecord; at: string; statePatch?: Partial<RuntimeState> };
type MergeRuntimeStateSnapshotMutation = { kind: 'mergeRuntimeStateSnapshot'; state: RuntimeState };

export type RuntimeMutation =
  | VoidRuntimeMutation
  | AppendRuntimeRunMutation
  | UpdateRuntimeRunMutation
  | AppendRuntimeCommandMutation
  | UpsertRuntimeIntentMutation
  | UpsertRuntimeActivationMutation
  | RejectRuntimeCommandMutation
  | CompleteRuntimeCommandMutation
  | MergeRuntimeStateSnapshotMutation;

export type RuntimeMutationResult = void | RuntimeCommandRecord | RuntimeRunRecord | RuntimeActivationRecord | RuntimeState | null;

export interface RuntimeStateMutationPort {
  apply(mutation: VoidRuntimeMutation): void;
  apply(mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
  apply(mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
  apply(mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: UpsertRuntimeIntentMutation): RuntimeState;
  apply(mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
  apply(mutation: RejectRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: CompleteRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: MergeRuntimeStateSnapshotMutation): RuntimeState;
}

export function applyRuntimeMutation(projectRoot: string, mutation: VoidRuntimeMutation): void;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpsertRuntimeIntentMutation): RuntimeState;
export function applyRuntimeMutation(projectRoot: string, mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: RejectRuntimeCommandMutation): RuntimeCommandRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: CompleteRuntimeCommandMutation): RuntimeCommandRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: MergeRuntimeStateSnapshotMutation): RuntimeState;
export function applyRuntimeMutation(projectRoot: string, mutation: RuntimeMutation): RuntimeMutationResult;
export function applyRuntimeMutation(projectRoot: string, mutation: RuntimeMutation): RuntimeMutationResult {
  switch (mutation.kind) {
    case 'patchRuntimeState':
      updateRuntimeState(projectRoot, mutation.patch);
      return;
    case 'replaceRuntimeState':
      updateRuntimeStateLockedDeriving(projectRoot, () => ({ state: mutation.state, result: undefined }));
      return;
    case 'completeActivation': {
      updateRuntimeStateLockedDeriving(projectRoot, (current) => ({
        state: reduceActivationCompletion(
          current,
          mutation.childCardId,
          mutation.outcome,
          mutation.completedAt,
          mutation.lifecycle ?? null,
        ) ?? current,
        result: undefined,
      }));
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
    case 'rejectRuntimeCommand':
      return updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const rejected = buildRejectedRuntimeCommandState({
          state: current,
          command: mutation.command,
          error: mutation.error,
          at: mutation.at,
        });
        return { state: rejected.state, result: rejected.rejectedCommand };
      });
    case 'completeRuntimeCommand':
      return updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const completed = buildCompletedRuntimeCommandState({
          state: current,
          command: mutation.command,
          at: mutation.at,
          statePatch: mutation.statePatch,
        });
        return { state: completed.state, result: completed.completedCommand };
      });
    case 'mergeRuntimeStateSnapshot':
      return updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const next = {
          ...mutation.state,
          runtime_commands: current.runtime_commands ?? mutation.state.runtime_commands ?? [],
          runtime_runs: current.runtime_runs ?? mutation.state.runtime_runs ?? [],
          runtime_activations: current.runtime_activations ?? mutation.state.runtime_activations ?? [],
        };
        return { state: next, result: next };
      });
  }
}

export function createRuntimeStateMutationPort(projectRoot: string): RuntimeStateMutationPort {
  return {
    apply: ((mutation: RuntimeMutation) => applyRuntimeMutation(projectRoot, mutation)) as RuntimeStateMutationPort['apply'],
  };
}
