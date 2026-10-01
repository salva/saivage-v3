import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { getWorkflowPresentation } from '../api/client';
import type { WorkflowPresentation } from '../api/types';

interface PresentationState { value: WorkflowPresentation | null; loading: boolean; error: string | null }
export const useWorkflowPresentationStore = defineStore('workflowPresentation', () => {
  const states = reactive<Record<string, PresentationState>>({});
  const pending = new Map<string, Promise<void>>();
  function scope(cardType: string): PresentationState {
    states[cardType] ??= { value: null, loading: false, error: null };
    return states[cardType];
  }
  function fetch(cardType: string): Promise<void> {
    const state = scope(cardType);
    if (state.value) return Promise.resolve();
    const active = pending.get(cardType);
    if (active) return active;
    state.loading = true;
    state.error = null;
    const request = getWorkflowPresentation(cardType).then((value) => { state.value = value; })
      .catch((error: unknown) => { state.error = error instanceof Error ? error.message : 'Configured workflow unavailable.'; })
      .finally(() => { state.loading = false; pending.delete(cardType); });
    pending.set(cardType, request);
    return request;
  }
  return { scope, fetch };
});
