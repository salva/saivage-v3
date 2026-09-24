import { useCardStore } from '../stores/cards';
import { useRuntimeStore } from '../stores/runtime';
import { useSyncStore } from '../stores/sync';
import { useContentPolicyStore } from '../stores/contentPolicy';
import { useAnalystChat } from '../stores/analystChat';

let started = false;

export function startAppBootstrap(): void {
  if (started) return;
  started = true;

  const syncStore = useSyncStore();
  const runtimeStore = useRuntimeStore();
  const cardStore = useCardStore();
  const contentPolicyStore = useContentPolicyStore();
  const analystChat = useAnalystChat();

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
  void analystChat.resolveIdentity().catch(() => {});
}
