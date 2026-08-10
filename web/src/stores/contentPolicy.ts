import { ref } from 'vue';
import { defineStore } from 'pinia';
import { OperatorApiError, getContentPolicyRuntime } from '../api/client';
import type { ContentPolicyRuntimeResponse } from '../api/types';

export const useContentPolicyStore = defineStore('contentPolicy', () => {
  const value = ref<ContentPolicyRuntimeResponse | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let epoch = 0;
  let controller: AbortController | null = null;

  async function refetch(): Promise<void> {
    const requestEpoch = ++epoch;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    error.value = null;
    try {
      const response = await getContentPolicyRuntime(controller.signal);
      if (requestEpoch !== epoch) return;
      value.value = response;
    } catch (caught) {
      if (requestEpoch !== epoch || (caught instanceof DOMException && caught.name === 'AbortError')) return;
      error.value = caught instanceof OperatorApiError ? caught.message : caught instanceof Error ? caught.message : 'Failed to load content-policy status';
      throw caught;
    } finally {
      if (requestEpoch === epoch) loading.value = false;
    }
  }

  function reset(): void {
    ++epoch;
    controller?.abort();
    controller = null;
    value.value = null;
    loading.value = false;
    error.value = null;
  }

  return { value, loading, error, refetch, reset };
});
