import { readConversation } from '../persistence/conversation-file.js';
import type { GlobalConversationSessionId } from '../schemas/index.js';

export function validateConfiguredGlobalConversation(
  projectRoot: string,
  sessionId: GlobalConversationSessionId,
): void {
  try {
    const conversation = readConversation(projectRoot, sessionId);
    if (conversation.unmatchedCall !== null) {
      throw new Error(
        `Configured global-agent conversation '${sessionId}' ends in an unmatched tool call and cannot be continued after startup.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
