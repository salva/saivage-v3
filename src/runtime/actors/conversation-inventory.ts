import { globalAgentConversationFile, cardConversationFile } from '../../persistence/layout.js';
import { conversationSessionIdentity, parseConversationSessionId, type ConversationSessionId } from '../../schemas/index.js';

export function conversationFile(projectRoot: string, rawSessionId: ConversationSessionId): string {
  const sessionId = parseConversationSessionId(rawSessionId);
  const parsed = conversationSessionIdentity(sessionId);
  return parsed.cardId === null ? globalAgentConversationFile(projectRoot,parsed.agentName) : cardConversationFile(projectRoot, parsed.cardId, parsed.agentName);
}

export { parseConversationSessionId };
