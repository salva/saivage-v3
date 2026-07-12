import type { ReadModelChanges } from '../application/read-model-changes.js';
import type { AgentMessage } from '../schemas/index.js';
import { writeCompactedConversationVersion, type ConversationIndex, type ConversationVersionReplacement } from '../runtime/actors/conversation-index.js';
import { appendConversationMessage, type ConversationAppendResult } from '../runtime/actors/conversation-store.js';

export interface ConversationMutationPort {
  append(message: AgentMessage): ConversationAppendResult;
  replaceActiveVersion(args: {
    sessionId: string;
    sourceVersion: number;
    content: string;
    compactedThrough: { message_id: string; round_id: string; timestamp: string };
    summaryIds: string[];
    compactionGeneration: number;
    bands: {
      merge_line: number;
      summary_line: number;
      trigger: number;
      snap: 'keep_straddler_verbatim' | 'compact_straddler';
    };
  }): { index: ConversationIndex; versionReplacement: ConversationVersionReplacement };
}

export function createConversationMutationPort(projectRoot: string, changes: ReadModelChanges): ConversationMutationPort {
  return {
    append(message) {
      const result = appendConversationMessage(projectRoot, message);
      if (result.appended) {
        changes.conversationChanged(message.session_id);
        changes.agentsChanged();
      }
      return result;
    },
    replaceActiveVersion(args) {
      const result = writeCompactedConversationVersion({ projectRoot, ...args });
      changes.conversationChanged(args.sessionId);
      changes.agentsChanged();
      return result;
    },
  };
}
