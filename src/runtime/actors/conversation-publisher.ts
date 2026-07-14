import type { EventBus, EventPayload } from '../../events/index.js';
import type { AgentMessage } from '../../schemas/index.js';
import type { ConversationVersionReplacement } from './conversation-inventory.js';

export interface ConversationChangePublisher {
  entryAppended(message: AgentMessage): void;
  versionReplaced(replacement: ConversationVersionReplacement): void;
}

export function createConversationChangePublisher(eventBus: Pick<EventBus, 'emit'>): ConversationChangePublisher {
  return {
    entryAppended(message) {
      eventBus.emit('conversation_changed', entryPayload(message));
    },
    versionReplaced(replacement) {
      eventBus.emit('conversation_changed', {
        session_id: replacement.sessionId,
        mutation: 'version_replaced',
        active_version: replacement.activeVersion,
        compacted_through: replacement.compactedThrough,
        compaction_generation: replacement.compactionGeneration,
      });
    },
  };
}

function entryPayload(message: AgentMessage): EventPayload<'conversation_changed'> {
  return {
    session_id: message.session_id,
    mutation: 'entry_appended',
    message_id: message.id,
    message_kind: message.kind,
    role: message.role,
    message_timestamp: message.timestamp,
  };
}
