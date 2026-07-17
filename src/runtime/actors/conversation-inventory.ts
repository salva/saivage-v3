import { analystConversationFile, cardConversationFile } from '../../persistence/layout.js';
import { conversationSessionIdentity, parseConversationSessionId, type ConversationSessionId } from '../../schemas/index.js';

export function conversationFile(projectRoot: string, rawSessionId: ConversationSessionId): string {
  const sessionId = parseConversationSessionId(rawSessionId);
  const parsed = conversationSessionIdentity(sessionId);
  if (parsed.cardId === null) return analystConversationFile(projectRoot);
  switch (parsed.role) {
    case 'planner': case 'reviewer': case 'executor': return cardConversationFile(projectRoot, parsed.cardId, parsed.role);
    case 'analyst': throw new Error('Analyst conversation identity cannot own a card.');
  }
}

export { parseConversationSessionId };
