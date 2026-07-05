import { useAgentStore } from '../stores/agents';
import { AUTH_TOKEN_CHANGED_EVENT, useAuthStore } from '../stores/auth';
import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';

let started = false;
let unregisters: Array<() => void> = [];
let tokenChangedHandler: (() => void) | null = null;

export function startAppBootstrap(): void {
  if (started) return;
  started = true;

  const syncStore = useSyncStore();
  const runtimeStore = useRuntimeStore();
  const cardStore = useCardStore();
  const agentStore = useAgentStore();
  const authStore = useAuthStore();

  unregisters = [
    syncStore.registerResource({
      resource: 'runtime',
      scope: 'core',
      refetch: runtimeStore.refetch,
      onRefetch: runtimeStore.markWsSync,
    }),
    syncStore.registerResource({ resource: 'cards', scope: 'core', refetch: cardStore.refetch }),
    syncStore.registerResource({
      resource: 'agents',
      scope: 'core',
      refetch: agentStore.refetch,
      onRefetch: agentStore.markWsSync,
    }),
  ];

  syncStore.connect();
  runtimeStore.refetch().catch(() => {});

  tokenChangedHandler = () => {
    authStore.refresh();
    syncStore.disconnect();
    syncStore.connect();
    runtimeStore.refetch().catch(() => {});
  };
  window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, tokenChangedHandler);
}

export function stopAppBootstrap(): void {
  const syncStore = useSyncStore();
  for (const unregister of unregisters) unregister();
  unregisters = [];
  if (tokenChangedHandler) window.removeEventListener(AUTH_TOKEN_CHANGED_EVENT, tokenChangedHandler);
  tokenChangedHandler = null;
  syncStore.disconnect();
  started = false;
}
