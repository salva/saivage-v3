import { describe, expect, it } from '@jest/globals';

import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';

const validIds = [
  'analyst:global',
  'planner:project',
  'reviewer:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
] as const satisfies readonly ConversationSessionId[];

const invalidIds = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;

describe('AgentMessage session identity', () => {
  it('uses the shared exact role/global identity union', () => {
    const identity: ConversationSessionId = null as unknown as AgentMessage['session_id'];
    expect(identity).toBeNull();
    for (const sessionId of validIds) expect(agentMessageSchema.parse(message(sessionId)).session_id).toBe(sessionId);
  });

  it.each(invalidIds)('rejects noncanonical complete message identity %s', (sessionId) => {
    expect(() => agentMessageSchema.parse(message(sessionId))).toThrow();
  });
});

function message(sessionId: string) {
  return {
    id: 'message-1', session_id: sessionId, role: 'user', kind: 'text', content: 'hello',
    round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0,
    timestamp: '2026-07-17T00:00:00.000Z',
  };
}
