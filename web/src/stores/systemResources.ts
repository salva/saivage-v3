import { defineStore } from 'pinia';
import { ref, onScopeDispose } from 'vue';
import { createOwnedFetch } from './owned-fetch';
import type { ConfigGetResponse, ControlActionsListResponse, ProvidersListResponse } from '../api/types';
import { getConfig, listControlActions, listProviders } from '../api/client';

/**
 * Read-only consumers of safe configuration, process-local provider
 * availability, and retained settled control actions. Each resource is
 * observed explicitly; none gains invalidation or polling.
 */
export const useSystemResourcesStore = defineStore('system-resources', () => {
  const config = ref<ConfigGetResponse | null>(null);
  const configRequest = createOwnedFetch();
  const configLoading = configRequest.pending;
  const configError = ref<string | null>(null);
  const providers = ref<ProvidersListResponse | null>(null);
  const providersRequest = createOwnedFetch();
  const providersLoading = providersRequest.pending;
  const providersError = ref<string | null>(null);
  const actions = ref<ControlActionsListResponse | null>(null);
  const actionsRequest = createOwnedFetch();
  const actionsLoading = actionsRequest.pending;
  const actionsError = ref<string | null>(null);

  async function fetchConfig(): Promise<void> {
    configError.value = null;
    await configRequest.run(getConfig, (value) => { config.value = value; }, (error) => {
      configError.value = error instanceof Error ? error.message : String(error);
    });
  }

  async function fetchProviders(): Promise<void> {
    providersError.value = null;
    await providersRequest.run(listProviders, (value) => { providers.value = value; }, (error) => {
      providersError.value = error instanceof Error ? error.message : String(error);
    });
  }

  async function fetchActions(): Promise<void> {
    actionsError.value = null;
    await actionsRequest.run((signal) => listControlActions({}, signal), (value) => { actions.value = value; }, (error) => {
      actionsError.value = error instanceof Error ? error.message : String(error);
    });
  }

  onScopeDispose(() => {
    configRequest.cancel();
    providersRequest.cancel();
    actionsRequest.cancel();
  });

  return {
    config, configLoading, configError, fetchConfig,
    providers, providersLoading, providersError, fetchProviders,
    actions, actionsLoading, actionsError, fetchActions,
  };
});
