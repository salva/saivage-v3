import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../src/contracts/conversation-validation.js';
import { serializeToolCallMessage } from '../../../src/contracts/persisted-tool-call.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../src/schemas/index.js';
import { buildSummarizerRoundInput, summarizeRound } from '../../../src/runtime/actors/compaction/summarizer.js';
import { SummaryResultValidationError } from '../../../src/runtime/actors/compaction/summarizer.js';
import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';

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

  it('preserves provider, projection-publication, cancellation, and malformed-success identities', async () => {
    const sessionId: ConversationSessionId = 'agent:planner:project';
    const rows = durableRound(sessionId, '11111111-1111-4111-8111-111111111111');
    const input = buildSummarizerRoundInput(validateConversation(sessionId, rows), 'activation', rows);
    const providerFailure = new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt('summary-input')], originalFailure: new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 200, message: 'overloaded' }), candidate: { provider: 'test', account: null, model: 'summary' } });
    const projected = jest.fn();
    await expect(summarizeRound({ input, summarizerProvider: { candidate: { provider: 'test', account: null, model: 'summary' }, completeTurn: async () => { throw providerFailure; }, projectProviderExchanges: projected }, signal: new AbortController().signal })).rejects.toBe(providerFailure);
    expect(projected).toHaveBeenCalledTimes(1);

    const publicationFailure = new Error('summary evidence publication failed');
    await expect(summarizeRound({ input, summarizerProvider: { candidate: { provider: 'test', account: null, model: 'summary' }, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [attempt('summary-input')] }), projectProviderExchanges: () => { throw publicationFailure; } }, signal: new AbortController().signal })).rejects.toBe(publicationFailure);

    const controller = new AbortController();
    const abortReason = new Error('stop summary admission');
    controller.abort(abortReason);
    const neverCalled = jest.fn(async () => { throw new Error('unexpected provider admission'); });
    await expect(summarizeRound({ input, summarizerProvider: { candidate: { provider: 'test', account: null, model: 'summary' }, completeTurn: neverCalled, projectProviderExchanges: jest.fn() }, signal: controller.signal })).rejects.toBe(abortReason);
    expect(neverCalled).not.toHaveBeenCalled();

    await expect(summarizeRound({ input, summarizerProvider: { candidate: { provider: 'test', account: null, model: 'summary' }, completeTurn: async () => ({ result: { kind: 'message' as const, content: '   ' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal })).rejects.toBeInstanceOf(SummaryResultValidationError);
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

function attempt(source_input_id: string): ProviderExchangeAttempt {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'summary', source_input_id, attempt_index: 0, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', status: 'error', terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'overloaded' } };
}
