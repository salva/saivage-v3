import { readCurrentConversationSegment } from '../../persistence/conversation-file.js';
import { cardConversationVersionFile, globalAgentConversationVersionFile } from '../../persistence/layout.js';
import { conversationSessionIdentity, type ConversationSessionId } from '../../schemas/index.js';

/** Exact current-segment path access is retained only for low-level persistence fault-injection tests. */
export function conversationFile(projectRoot: string, sessionId: ConversationSessionId): string {
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  if (!segment) throw new Error(`Conversation '${sessionId}' has no current segment file.`);
  const identity = conversationSessionIdentity(sessionId);
  return identity.cardId === null
    ? globalAgentConversationVersionFile(projectRoot, identity.agentName, segment.entry.filename)
    : cardConversationVersionFile(projectRoot, identity.cardId, identity.agentName, segment.entry.filename);
}
