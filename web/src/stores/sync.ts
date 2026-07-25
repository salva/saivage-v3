import { computed } from 'vue';
import { defineStore } from 'pinia';
import { syncClient, type LeaseInvalidation, type SyncResourceRegistration } from '../sync/client';
import type { ConversationSessionId } from '../api/contracts';

export const useSyncStore = defineStore('sync', () => {
  const connectionState = computed(() => syncClient.connectionState.value);
  const lastConnectedAt = computed(() => syncClient.lastConnectedAt.value);
  const lastEventAt = computed(() => syncClient.lastEventAt.value);

  function connect(): void {
    syncClient.start();
  }

  function disconnect(): void {
    syncClient.stop();
  }
  function reconfigure(): void {
    syncClient.reconfigure();
  }

  function registerResource(registration: SyncResourceRegistration): () => void {
    return syncClient.register(registration);
  }

  function openConversation(
    sessionId: ConversationSessionId,
    refetch: () => Promise<void>,
  ): () => void {
    return syncClient.openConversation(sessionId, refetch);
  }
  const openAgents = (callback: (frame: LeaseInvalidation) => Promise<void>) =>
    syncClient.openAgents(callback);
  const openCardAgentSessions = (
    cardId: string,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ) => syncClient.openCardAgentSessions(cardId, callback);
  const openLlmExchange = (
    sessionId: ConversationSessionId,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ) => syncClient.openLlmExchange(sessionId, callback);

  function sendMessage(text: string): void {
    syncClient.sendMessage(text);
  }

  return {
    connectionState,
    lastConnectedAt,
    lastEventAt,
    connect,
    disconnect,
    reconfigure,
    registerResource,
    openAgents,
    openCardAgentSessions,
    openConversation,
    openLlmExchange,
    sendMessage,
  };
});
