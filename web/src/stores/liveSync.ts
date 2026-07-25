import { defineStore } from 'pinia';
import { useSyncStore } from './sync';
import type { LeaseInvalidation, SyncResourceRegistration } from '../sync/client';
import type { ConversationSessionId } from '../api/contracts';

export const useLiveSyncStore = defineStore('live-sync', () => {
  function registerResource(registration: SyncResourceRegistration): () => void {
    return useSyncStore().registerResource(registration);
  }

  function openConversation(
    sessionId: ConversationSessionId,
    refetch: () => Promise<void>,
  ): () => void {
    return useSyncStore().openConversation(sessionId, refetch);
  }
  const openAgents = (callback: (frame: LeaseInvalidation) => Promise<void>) =>
    useSyncStore().openAgents(callback);
  const openCardAgentSessions = (
    cardId: string,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ) => useSyncStore().openCardAgentSessions(cardId, callback);
  const openLlmExchange = (
    sessionId: ConversationSessionId,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ) => useSyncStore().openLlmExchange(sessionId, callback);

  return { registerResource, openAgents, openCardAgentSessions, openConversation, openLlmExchange };
});
