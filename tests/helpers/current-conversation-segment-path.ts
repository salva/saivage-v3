import { readConversationCatalog } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile, globalAgentConversationVersionFile } from '../../src/persistence/layout.js';
import { conversationSessionIdentity, type ConversationSessionId } from '../../src/schemas/index.js';

export function currentConversationSegmentPath(projectRoot: string, sessionId: ConversationSessionId): string {
  const catalog = readConversationCatalog(projectRoot, sessionId);
  if (catalog.currentVersion === null) throw new Error(`Conversation '${sessionId}' has no current segment file.`);
  const matches = catalog.versions.filter((entry) => entry.version === catalog.currentVersion);
  if (matches.length !== 1) throw new Error(`Conversation '${sessionId}' current version must resolve exactly once.`);
  const identity = conversationSessionIdentity(sessionId);
  return identity.cardId === null
    ? globalAgentConversationVersionFile(projectRoot, identity.agentName, matches[0]!.filename)
    : cardConversationVersionFile(projectRoot, identity.cardId, identity.agentName, matches[0]!.filename);
}
