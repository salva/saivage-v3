import { computed } from 'vue';
import { defineStore } from 'pinia';
import { syncClient, type ConversationInvalidation, type LeaseInvalidation, type SyncResourceRegistration } from '../sync/client';
import type { ConversationSessionId } from '../api/contracts';

export const useSyncStore = defineStore('sync', () => {
  const connectionState = computed(() => syncClient.connectionState.value);

  function connect(): void {
    syncClient.start();
  }

  function reconfigure(): void {
    syncClient.reconfigure();
  }

  function registerResource(registration: SyncResourceRegistration): () => void {
    return syncClient.register(registration);
  }

  function openConversation(
    sessionId: ConversationSessionId,
    refetch: (frame: ConversationInvalidation) => Promise<void>,
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

  return {
    connectionState,
    connect,
    reconfigure,
    registerResource,
    openAgents,
    openCardAgentSessions,
    openConversation,
    openLlmExchange,
  };
});
