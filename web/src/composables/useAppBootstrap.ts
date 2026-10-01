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

  syncStore.registerResource({
    resource: 'cards',
    onInvalidate: (target) => { cardStore.onInvalidate(target); },
    onReconnect: () => { cardStore.onReconnect(); },
  });
  syncStore.registerResource({
    resource: 'runtime',
    refetch: runtimeStore.refetch,
  });
  syncStore.connect();
  runtimeStore.refetch().catch(() => {});
  void cardStore.ensureRoot();
}
