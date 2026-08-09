import { readConversation } from '../persistence/conversation-file.js';
import type { GlobalConversationSessionId } from '../schemas/index.js';

export function validateConfiguredAnalystConversation(
  projectRoot: string,
  sessionId: GlobalConversationSessionId,
): void {
  try {
    const conversation = readConversation(projectRoot, sessionId);
    if (conversation.unmatchedCall !== null) {
      throw new Error(
        `Configured Analyst conversation '${sessionId}' ends in an unmatched tool call and cannot be continued after startup.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
