import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../src/contracts/conversation-validation.js';
import { serializeToolCallMessage } from '../../../src/contracts/persisted-tool-call.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../src/schemas/index.js';
import { buildSummarizerRoundInput, summarizeRound } from '../../../src/runtime/actors/compaction/summarizer.js';

describe('compaction summarizer projection boundary', () => {
  it('projects recoverable result bodies only after durable validation and reaches the provider without durable revalidation', async () => {
    const sessionId: ConversationSessionId = 'agent:planner:project';
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    const rows = durableRound(sessionId, sourceInputId);
    const conversation = validateConversation(sessionId, rows);
    const input = buildSummarizerRoundInput(conversation, 'activation', rows);
    const projectedResult = input.providerConversation.messages.find((row) => row.kind === 'tool_result')!;

    expect(JSON.parse(projectedResult.content)).toMatchObject({ success: true, recovered_from: { tool: 'read', args: { path: 'large.txt' } } });
    expect(() => validateConversation(sessionId, input.providerConversation.messages)).toThrow(/malformed content/);

    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }));
    await expect(summarizeRound({
      input,
      summarizerProvider: { candidate: { provider: 'test', account: null, model: 'summary' }, completeTurn, projectProviderExchanges: jest.fn() },
      signal: new AbortController().signal,
    })).resolves.toBe('summary');
    expect(completeTurn).toHaveBeenCalledTimes(1);
  });
});

function durableRound(sessionId: ConversationSessionId, sourceInputId: string): AgentMessage[] {
  const timestamp = '2026-08-09T00:00:00.000Z';
  const common = { session_id: sessionId, timestamp, round_id: `r-user-${'0'.repeat(32)}` };
  return [
    agentMessageSchema.parse({ ...common, id: 'activation', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: sourceInputId, timestamp }), message_index: 0, block_index: 0 }),
    agentMessageSchema.parse({ ...common, id: `${sourceInputId}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify(serializeToolCallMessage({ id: 'call-1', name: 'read', args: { path: 'large.txt' } })), message_index: 1, block_index: 0 }),
    agentMessageSchema.parse({ ...common, id: `${sourceInputId}:tool-result:call-1`, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ success: true, data: { content: 'x'.repeat(10_000) } }), message_index: 2, block_index: 0 }),
  ];
}
