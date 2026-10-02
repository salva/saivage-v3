import { onMounted, onUnmounted, watch, type Ref } from 'vue';
import type { ConversationSessionId } from '../api/contracts';
import { useAgentStore } from '../stores/agents';
import { useSyncStore } from '../stores/sync';

export function useSelectedConversation(sessionId: ConversationSessionId, version?: Ref<number | null>): {
  reload(): Promise<void>;
  fetchVersions(): Promise<void>;
  selectVersion(version: number | null): Promise<void>;
} {
  const agentStore = useAgentStore();
  const syncStore = useSyncStore();
  let token: ReturnType<typeof agentStore.beginConversationSelection>;
  let close: () => void;
  let acknowledged = false;

  onMounted(() => {
    token = agentStore.beginConversationSelection(sessionId);
    if (version) watch(version, (value) => { void agentStore.selectConversationVersion(token, value); }, { immediate: true });
    close = syncStore.openConversation(sessionId, (frame) => {
      acknowledged = true;
      return Promise.all([
        agentStore.refetchConversation(token, frame),
        frame === null ? agentStore.fetchSelectedSession(token) : Promise.resolve(),
      ]).then(() => undefined);
    });
  });

  async function reload(): Promise<void> {
    if (!acknowledged) return;
    await Promise.all([
      agentStore.fetchConversation(token).catch(() => {}),
      agentStore.fetchSelectedSession(token),
    ]);
  }

  function fetchVersions(): Promise<void> {
    return agentStore.fetchConversationVersions(token);
  }

  function selectVersion(version: number | null): Promise<void> {
    return agentStore.selectConversationVersion(token, version);
  }

  onUnmounted(() => {
    close();
    agentStore.clearConversationSelection(token);
  });

  return { reload, fetchVersions, selectVersion };
}
