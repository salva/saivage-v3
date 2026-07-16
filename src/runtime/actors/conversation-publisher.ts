import type { EventBus, EventPayload } from '../../events/index.js';
import type { AgentMessage } from '../../schemas/index.js';

export interface ConversationChangePublisher {
  entryAppended(message: AgentMessage): void;
}

export function createConversationChangePublisher(eventBus: Pick<EventBus, 'emit'>): ConversationChangePublisher {
  return {
    entryAppended(message) {
      eventBus.emit('conversation_changed', entryPayload(message));
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
