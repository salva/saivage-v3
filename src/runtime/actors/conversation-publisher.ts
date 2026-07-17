import type { EventBus, EventPayload } from '../../events/index.js';
import { parseConversationSessionId, type AgentMessage } from '../../schemas/index.js';

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
  const sessionId = parseConversationSessionId(message.session_id);
  return {
    session_id: sessionId,
    mutation: 'entry_appended',
    message_id: message.id,
    message_kind: message.kind,
    role: message.role,
    message_timestamp: message.timestamp,
  };
}
