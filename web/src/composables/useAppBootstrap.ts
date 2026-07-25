import { AUTH_TOKEN_CHANGED_EVENT, useAuthStore } from '../stores/auth';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';

let started = false;

export function startAppBootstrap(): void {
  if (started) return;
  started = true;

  const syncStore = useSyncStore();
  const runtimeStore = useRuntimeStore();
  const cardStore = useCardStore();
  const authStore = useAuthStore();

  syncStore.registerResource({
    resource: 'cards',
    onInvalidate: cardStore.onInvalidate,
    onReconnect: cardStore.onReconnect,
  });
  syncStore.registerResource({
    resource: 'runtime',
    scope: 'core',
    requestOwnership: 'sync-client',
    refetch: runtimeStore.refetch,
    onRefetch: runtimeStore.markWsSync,
  });
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
  void cardStore.ensureRoot();

  window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, () => {
    authStore.refresh();
    syncStore.reconfigure();
    runtimeStore.refetch().catch(() => {});
    cardStore.reset();
    void cardStore.ensureRoot();
  });
}
