import type { ActionableErrorEnvelope, ActivationCompletionOutcome, CardLifecycleState, RuntimeActivationRecord, RuntimeCommandRecord, RuntimeRunRecord, RuntimeState } from '../schemas/index.js';
import { reduceActivationCompletion } from './activation-completion-reducer.js';
import { planOpenPlannerRunTerminalUpdate, planPlannerRunSessionBinding } from './planner-run-reducers.js';
import {
  buildCompletedRuntimeCommandState,
  buildRejectedRuntimeCommandState,
} from './runtime-command-state.js';
import {
  appendRuntimeCommand,
  appendRuntimeRun,
  updateRuntimeRun,
  updateRuntimeState,
  updateRuntimeStateLockedDeriving,
  upsertRuntimeActivation,
  RuntimeActivationInvariantError,
} from './state.js';

type AppendRuntimeCommandArgs = Parameters<typeof appendRuntimeCommand>;
type AppendRuntimeRunInput = Parameters<typeof appendRuntimeRun>[1];
type UpsertRuntimeActivationInput = Parameters<typeof upsertRuntimeActivation>[1];

type VoidRuntimeMutation =
  | { kind: 'patchRuntimeState'; patch: Partial<RuntimeState> }
  | { kind: 'replaceRuntimeState'; state: RuntimeState }
  | { kind: 'completeActivation'; childCardId: string; outcome: ActivationCompletionOutcome; completedAt: string; lifecycle?: CardLifecycleState | null };

type AppendRuntimeRunMutation = { kind: 'appendRuntimeRun'; run: AppendRuntimeRunInput };
type UpdateRuntimeRunMutation = { kind: 'updateRuntimeRun'; runId: string; updates: Partial<RuntimeRunRecord> };
type FinishOpenPlannerRunMutation = { kind: 'finishOpenPlannerRun'; goalId: string; result: 'blocked' | 'failed'; at: string };
type BindPlannerSessionToOpenRunMutation = { kind: 'bindPlannerSessionToOpenRun'; goalId: string; plannerSessionId: string };
type AppendRuntimeCommandMutation = { kind: 'appendRuntimeCommand'; commandKind: AppendRuntimeCommandArgs[1]; source: AppendRuntimeCommandArgs[2] };
type UpsertRuntimeActivationMutation = { kind: 'upsertRuntimeActivation'; activation: UpsertRuntimeActivationInput };
type RejectRuntimeCommandMutation = { kind: 'rejectRuntimeCommand'; command: RuntimeCommandRecord; error: ActionableErrorEnvelope; at: string };
type CompleteRuntimeCommandMutation = { kind: 'completeRuntimeCommand'; command: RuntimeCommandRecord; at: string; statePatch?: Partial<RuntimeState> };
type MergeRuntimeStateSnapshotMutation = { kind: 'mergeRuntimeStateSnapshot'; state: RuntimeState };

export type RuntimeMutation =
  | VoidRuntimeMutation
  | AppendRuntimeRunMutation
  | UpdateRuntimeRunMutation
  | FinishOpenPlannerRunMutation
  | BindPlannerSessionToOpenRunMutation
  | AppendRuntimeCommandMutation
  | UpsertRuntimeActivationMutation
  | RejectRuntimeCommandMutation
  | CompleteRuntimeCommandMutation
  | MergeRuntimeStateSnapshotMutation;

export type RuntimeMutationResult = void | RuntimeCommandRecord | RuntimeRunRecord | RuntimeActivationRecord | RuntimeState | null;

export interface RuntimeStateMutationPort {
  apply(mutation: VoidRuntimeMutation): void;
  apply(mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
  apply(mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
  apply(mutation: FinishOpenPlannerRunMutation): RuntimeRunRecord | null;
  apply(mutation: BindPlannerSessionToOpenRunMutation): RuntimeRunRecord | null;
  apply(mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: UpsertRuntimeActivationMutation): RuntimeActivationRecord;
  apply(mutation: RejectRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: CompleteRuntimeCommandMutation): RuntimeCommandRecord;
  apply(mutation: MergeRuntimeStateSnapshotMutation): RuntimeState;
}

export function applyRuntimeMutation(projectRoot: string, mutation: VoidRuntimeMutation): void;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeRunMutation): RuntimeRunRecord;
export function applyRuntimeMutation(projectRoot: string, mutation: UpdateRuntimeRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: FinishOpenPlannerRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: BindPlannerSessionToOpenRunMutation): RuntimeRunRecord | null;
export function applyRuntimeMutation(projectRoot: string, mutation: AppendRuntimeCommandMutation): RuntimeCommandRecord;
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
      updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const next = reduceActivationCompletion(
          current,
          mutation.childCardId,
          mutation.outcome,
          mutation.completedAt,
          mutation.lifecycle ?? null,
        );
        if (!next) {
          throw new RuntimeActivationInvariantError(
            `Runtime activation invariant violation: completeActivation for '${mutation.childCardId}' had no matching unresolved activation.`,
          );
        }
        return { state: next, result: undefined };
      });
      return;
    }
    case 'appendRuntimeRun':
      return appendRuntimeRun(projectRoot, mutation.run);
    case 'updateRuntimeRun':
      return updateRuntimeRun(projectRoot, mutation.runId, mutation.updates);
    case 'finishOpenPlannerRun':
      return updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const plan = planOpenPlannerRunTerminalUpdate({ state: current, goalId: mutation.goalId, result: mutation.result, nowIso: mutation.at });
        if (!plan) return { state: current, result: null };
        const runtime_runs = current.runtime_runs.map((run) => run.run_id === plan.runId ? { ...run, ...plan.updates } : run);
        return { state: { ...current, runtime_runs }, result: runtime_runs.find((run) => run.run_id === plan.runId) ?? null };
      });
    case 'bindPlannerSessionToOpenRun':
      return updateRuntimeStateLockedDeriving(projectRoot, (current) => {
        const plan = planPlannerRunSessionBinding({ state: current, goalId: mutation.goalId, plannerSessionId: mutation.plannerSessionId });
        if (!plan) return { state: current, result: null };
        const runtime_runs = current.runtime_runs.map((run) => run.run_id === plan.runId ? { ...run, ...plan.updates } : run);
        return { state: { ...current, runtime_runs }, result: runtime_runs.find((run) => run.run_id === plan.runId) ?? null };
      });
    case 'appendRuntimeCommand':
      return appendRuntimeCommand(projectRoot, mutation.commandKind, mutation.source);
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
          runtime_commands: current.runtime_commands,
          runtime_runs: current.runtime_runs,
          runtime_activations: current.runtime_activations,
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
