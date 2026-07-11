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

  syncStore.registerResource({
      resource: 'runtime',
      scope: 'core',
      refetch: runtimeStore.refetch,
      onRefetch: runtimeStore.markWsSync,
    });
  syncStore.registerResource({ resource: 'cards', scope: 'core', refetch: cardStore.refetch });
  syncStore.registerResource({
      resource: 'agents',
      scope: 'core',
      refetch: agentStore.refetch,
      onRefetch: agentStore.markWsSync,
    });

  syncStore.connect();
  runtimeStore.refetch().catch(() => {});

  window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, () => {
    authStore.refresh();
    syncStore.reconfigure();
    runtimeStore.refetch().catch(() => {});
  });
}
