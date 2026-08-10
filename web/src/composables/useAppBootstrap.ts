import { AUTH_TOKEN_CHANGED_EVENT, useAuthStore } from '../stores/auth';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';
import { useContentPolicyStore } from '../stores/contentPolicy';

let started = false;

export function startAppBootstrap(): void {
  if (started) return;
  started = true;

  const syncStore = useSyncStore();
  const runtimeStore = useRuntimeStore();
  const cardStore = useCardStore();
  const authStore = useAuthStore();
  const contentPolicyStore = useContentPolicyStore();

  syncStore.registerResource({
    resource: 'cards',
    onInvalidate: (target) => { cardStore.onInvalidate(target); void contentPolicyStore.refetch().catch(() => {}); },
    onReconnect: () => { cardStore.onReconnect(); void contentPolicyStore.refetch().catch(() => {}); },
  });
  syncStore.registerResource({
    resource: 'runtime',
    refetch: runtimeStore.refetch,
  });
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
  void cardStore.ensureRoot();
  void contentPolicyStore.refetch().catch(() => {});

  window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, () => {
    authStore.refresh();
    syncStore.reconfigure();
    runtimeStore.refetch().catch(() => {});
    cardStore.reset();
    contentPolicyStore.reset();
    void cardStore.ensureRoot();
    void contentPolicyStore.refetch().catch(() => {});
  });
}
