import { conversationSessionIdentity, parseConversationSessionId, type ConversationSessionId } from '../../src/schemas/index.js';
import type { CompactionProgress, ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';

export function executingLlmSnapshots(sessionIds: readonly ConversationSessionId[], compaction: CompactionProgress | null = null): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot> {
  return new Map(sessionIds.map((sessionId) => {
    const id = parseConversationSessionId(sessionId);
    const identity = conversationSessionIdentity(id);
    return [id, { sessionId: id, agentId: id, agentName: identity.agentName, cardId: identity.cardId, activity: { mode: 'active', barrier: null }, compaction }] as const;
  }));
}

export const noCompactionProgress = Object.freeze({ foldStarted() {}, foldCompleted() {}, foldFailed() {} });
