import type { RuntimeState } from '../schemas/index.js';
import { updateRuntimeState, updateRuntimeStateLockedDeriving } from './state.js';

type VoidRuntimeMutation =
  | { kind: 'patchRuntimeState'; patch: Partial<RuntimeState> }
  | { kind: 'replaceRuntimeState'; state: RuntimeState }
  | { kind: 'completeActivation'; childCardId: string };

type MergeRuntimeStateSnapshotMutation = { kind: 'mergeRuntimeStateSnapshot'; state: RuntimeState };

export type RuntimeMutation = VoidRuntimeMutation | MergeRuntimeStateSnapshotMutation;
export type RuntimeMutationResult = void | RuntimeState;

export interface RuntimeStateMutationPort {
  apply(mutation: VoidRuntimeMutation): void;
  apply(mutation: MergeRuntimeStateSnapshotMutation): RuntimeState;
}

export function applyRuntimeMutation(projectRoot: string, mutation: VoidRuntimeMutation): void;
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
    case 'completeActivation':
      return;
    case 'mergeRuntimeStateSnapshot':
      return updateRuntimeStateLockedDeriving(projectRoot, () => ({ state: mutation.state, result: mutation.state }));
  }
}

export function createRuntimeStateMutationPort(projectRoot: string): RuntimeStateMutationPort {
  return {
    apply: ((mutation: RuntimeMutation) => applyRuntimeMutation(projectRoot, mutation)) as RuntimeStateMutationPort['apply'],
  };
}
