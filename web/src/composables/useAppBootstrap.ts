import { useAgentStore } from '../stores/agents';
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
  const agentStore = useAgentStore();
  const authStore = useAuthStore();

  syncStore.registerResource({ resource: 'cards', onInvalidate: cardStore.onInvalidate, onReconnect: cardStore.onReconnect });
  syncStore.registerResource({
    resource: 'runtime',
    scope: 'core',
    requestOwnership: 'sync-client',
    refetch: runtimeStore.refetch,
    onRefetch: runtimeStore.markWsSync,
  });
  syncStore.registerResource({
    resource: 'agents',
    scope: 'core',
    requestOwnership: 'resource-store',
    refetch: agentStore.fetchSessions,
    onRefetch: agentStore.markWsSync,
  });

  const token = agentStore.beginSessionsBootstrap();
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
  void cardStore.ensureRoot().then(
    () => agentStore.finishSessionsBootstrap(token).catch(() => {}),
    () => agentStore.finishSessionsBootstrap(token).catch(() => {}),
  );

  window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, () => {
    authStore.refresh();
    const replacementToken = agentStore.beginSessionsBootstrap();
    syncStore.reconfigure();
    runtimeStore.refetch().catch(() => {});
    cardStore.reset();
    void cardStore.ensureRoot().then(
      () => agentStore.finishSessionsBootstrap(replacementToken).catch(() => {}),
      () => agentStore.finishSessionsBootstrap(replacementToken).catch(() => {}),
    );
  });
}
