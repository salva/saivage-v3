import { describe, expect, it, jest } from '@jest/globals';

import { createConversationChangePublisher } from '../../../src/runtime/actors/conversation-publisher.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../src/schemas/index.js';

const validIds = ['analyst:global', 'planner:project', 'reviewer:project', 'executor:project'] as const satisfies readonly ConversationSessionId[];
const invalidIds = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;

describe('conversation change publisher identity ingress', () => {
  it.each(validIds)('emits exact identity %s unchanged', (sessionId) => {
    const emit = jest.fn();
    createConversationChangePublisher({ emit }).entryAppended(agentMessageSchema.parse(message(sessionId)));
    expect(emit).toHaveBeenCalledWith('conversation_changed', expect.objectContaining({ session_id: sessionId, message_id: 'message-1' }));
  });

  it.each(invalidIds)('fails forged identity %s before emit', (sessionId) => {
    const emit = jest.fn();
    const publisher = createConversationChangePublisher({ emit });
    const forged = message(sessionId) as unknown as AgentMessage;
    expect(() => publisher.entryAppended(forged)).toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});

function message(sessionId: string) {
  return {
    id: 'message-1', session_id: sessionId, role: 'user', kind: 'text', content: 'hello',
    round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0,
    timestamp: '2026-07-17T00:00:00.000Z',
  };
}
