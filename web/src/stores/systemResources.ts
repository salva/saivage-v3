import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ConfigGetResponse, ControlActionsListResponse, ProvidersListResponse } from '../api/types';
import { getConfig, listControlActions, listProviders } from '../api/client';

/**
 * Read-only consumers of safe configuration, process-local provider
 * availability, and retained settled control actions. Each resource is
 * observed explicitly; none gains invalidation or polling.
 */
export const useSystemResourcesStore = defineStore('system-resources', () => {
  const config = ref<ConfigGetResponse | null>(null);
  const configLoading = ref(false);
  const configError = ref<string | null>(null);
  const providers = ref<ProvidersListResponse | null>(null);
  const providersLoading = ref(false);
  const providersError = ref<string | null>(null);
  const actions = ref<ControlActionsListResponse | null>(null);
  const actionsLoading = ref(false);
  const actionsError = ref<string | null>(null);

  async function fetchConfig(): Promise<void> {
    configLoading.value = true;
    configError.value = null;
    try {
      config.value = await getConfig();
    } catch (error) {
      configError.value = error instanceof Error ? error.message : String(error);
    } finally {
      configLoading.value = false;
    }
  }

  async function fetchProviders(): Promise<void> {
    providersLoading.value = true;
    providersError.value = null;
    try {
      providers.value = await listProviders();
    } catch (error) {
      providersError.value = error instanceof Error ? error.message : String(error);
    } finally {
      providersLoading.value = false;
    }
  }

  async function fetchActions(): Promise<void> {
    actionsLoading.value = true;
    actionsError.value = null;
    try {
      actions.value = await listControlActions();
    } catch (error) {
      actionsError.value = error instanceof Error ? error.message : String(error);
    } finally {
      actionsLoading.value = false;
    }
  }

  return {
    config, configLoading, configError, fetchConfig,
    providers, providersLoading, providersError, fetchProviders,
    actions, actionsLoading, actionsError, fetchActions,
  };
});
