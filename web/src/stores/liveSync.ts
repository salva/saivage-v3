import { defineStore } from 'pinia';
import { useSyncStore } from './sync';
import type { SyncResourceRegistration } from '../sync/client';
import type { ConversationSessionId } from '../api/contracts';

export const useLiveSyncStore = defineStore('live-sync', () => {
  function registerResource(registration: SyncResourceRegistration): () => void {
    return useSyncStore().registerResource(registration);
  }

  function openConversation(sessionId: ConversationSessionId, refetch: () => Promise<void>): () => void {
    return useSyncStore().openConversation(sessionId, refetch);
  }

  return { registerResource, openConversation };
});
