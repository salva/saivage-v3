import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../src/contracts/conversation-validation.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, toolRowPolicies } from '../../helpers/row-policy-fixtures.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import {
  internalCompactionSummarySessionId,
  SummaryResultValidationError,
  SUMMARY_COMPLETION_TOKENS,
  type SummaryRequestSerialization,
  type SummarizerProviderPort,
} from '../../../src/runtime/actors/compaction/summarizer.js';
import { materializeAccumulatedSummary } from '../../../src/runtime/actors/compaction/summary-materializer.js';
import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';

const SESSION: ConversationSessionId = 'agent:planner:project';
const SOURCE_INPUT_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;
const BUDGET = { inputBudgetTokens: 100_000, completionReserveTokens: 20_000 };

describe('compaction summarizer projection boundary', () => {
  it('delivers every settled result body unchanged to the summarizer under the internal summary identity', async () => {
    const rows = durableRound(SESSION, SOURCE_INPUT_ID);
    const conversation = validateConversation(SESSION, rows);
    const completeTurn = jest.fn(async (input: Parameters<SummarizerProviderPort['completeTurn']>[0]) => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }));
    const provider: SummarizerProviderPort = { candidate: CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn, projectProviderExchanges: jest.fn() };
    await expect(materializeAccumulatedSummary({
      conversation,
      inheritedHistory: null,
      coveredRows: rows,
      summarizerProvider: provider,
      budget: BUDGET,
      signal: new AbortController().signal,
    })).resolves.toBe('summary');
    expect(completeTurn).toHaveBeenCalledTimes(1);
    const input = completeTurn.mock.calls[0]![0];
    expect(input.capabilityRequest).toEqual({ requiresTools: false, requiresExclusiveToolChoice: true });
    expect(input.modelParams).toEqual({ temperature: 0, maxTokens: SUMMARY_COMPLETION_TOKENS });
    expect(input.sessionId).toBe(internalCompactionSummarySessionId(SESSION));
    expect(input.sessionId).not.toMatch(/^agent:/);
    const bundle = input.providerConversation.messages.find((row) => row.content.includes('tool_result_content='));
    expect(bundle!.content).toContain(`x`.repeat(10_000));
    expect(bundle!.content).toContain(`[order 1/1] [kind=settled_tool_bundle source=${SOURCE_INPUT_ID}:call-1 tool=read audience=primary_and_summarizer]`);
  });

  it('measures each request once and sends exactly the admitted serialized bytes', async () => {
    const rows = durableRound(SESSION, SOURCE_INPUT_ID);
    const conversation = validateConversation(SESSION, rows);
    const serializations: SummaryRequestSerialization[] = [];
    const provider: SummarizerProviderPort = {
      candidate: CANDIDATE,
      serializeSummaryRequest: (input) => {
        const serialization = deterministicSummarySerialization(input);
        serializations.push(serialization);
        return serialization;
      },
      completeTurn: async (input, admitted) => {
        expect(deterministicSummarySerialization(input).requestSha256).toBe(admitted.requestSha256);
        expect(admitted.serializedRequest).toBe(serializations.at(-1)!.serializedRequest);
        return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
      },
      projectProviderExchanges: jest.fn(),
    };
    await materializeAccumulatedSummary({ conversation, inheritedHistory: null, coveredRows: rows, summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    expect(serializations).toHaveLength(3);
    expect(JSON.parse(serializations[0]!.serializedRequest).messages).toEqual([]);
    const measured = serializations[1]!.serializedRequest;
    expect(measured).toContain('Summarize the labeled Saivage conversation material');
    expect(measured).toContain('[order 1/1]');
    expect(measured).toContain('[kind=settled_tool_bundle source=');
    expect(serializations[2]!.serializedRequest).toContain('summary');
  });

  it('preserves provider, projection-publication, cancellation, and malformed-success identities', async () => {
    const rows = durableRound(SESSION, SOURCE_INPUT_ID);
    const conversation = validateConversation(SESSION, rows);
    const providerFailure = new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt('summary-input')], originalFailure: new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 200, message: 'overloaded' }), candidate: CANDIDATE });
    const projected = jest.fn();
    await expect(materializeAccumulatedSummary({
      conversation,
      inheritedHistory: null,
      coveredRows: rows,
      summarizerProvider: { candidate: CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => { throw providerFailure; }, projectProviderExchanges: projected },
      budget: BUDGET,
      signal: new AbortController().signal,
    })).rejects.toBe(providerFailure);
    expect(projected).toHaveBeenCalledTimes(1);
    expect(projected).toHaveBeenCalledWith(internalCompactionSummarySessionId(SESSION), expect.any(String), [expect.anything()], { assistantOutputIds: [], terminalConversationOutputId: null });

    const publicationFailure = new Error('summary evidence publication failed');
    await expect(materializeAccumulatedSummary({
      conversation,
      inheritedHistory: null,
      coveredRows: rows,
      summarizerProvider: { candidate: CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [attempt('summary-input')] }), projectProviderExchanges: () => { throw publicationFailure; } },
      budget: BUDGET,
      signal: new AbortController().signal,
    })).rejects.toBe(publicationFailure);

    const controller = new AbortController();
    const abortReason = new Error('stop summary admission');
    controller.abort(abortReason);
    const neverCalled = jest.fn(async () => { throw new Error('unexpected provider admission'); });
    await expect(materializeAccumulatedSummary({
      conversation,
      inheritedHistory: null,
      coveredRows: rows,
      summarizerProvider: { candidate: CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: neverCalled, projectProviderExchanges: jest.fn() },
      budget: BUDGET,
      signal: controller.signal,
    })).rejects.toBe(abortReason);
    expect(neverCalled).not.toHaveBeenCalled();

    await expect(materializeAccumulatedSummary({
      conversation,
      inheritedHistory: null,
      coveredRows: rows,
      summarizerProvider: { candidate: CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: '   ' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() },
      budget: BUDGET,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(SummaryResultValidationError);
  });
});

function durableRound(sessionId: ConversationSessionId, sourceInputId: string): AgentMessage[] {
  const timestamp = '2026-08-09T00:00:00.000Z';
  const common = { session_id: sessionId, timestamp, round_id: `r-user-${'0'.repeat(32)}` };
  const settled = JSON.stringify({ success: true, data: { content: 'x'.repeat(10_000) } });
  const policies = toolRowPolicies({ content: settled });
  return [
    agentMessageSchema.parse({ ...common, context_policy: ACTIVITY_ROW_POLICY, id: 'activation-1', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: sourceInputId, timestamp }), message_index: 0, block_index: 0 }),
    agentMessageSchema.parse({ ...common, context_policy: policies.call, id: `${sourceInputId}:tool-call:call-1`, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'large.txt' }) } }] }), message_index: 1, block_index: 0 }),
    agentMessageSchema.parse({ ...common, context_policy: policies.result, id: `${sourceInputId}:tool-result:call-1`, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'call-1', content: settled, message_index: 2, block_index: 0 }),
  ];
}

function attempt(source_input_id: string): ProviderExchangeAttempt {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'summary', source_input_id, attempt_index: 0, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', status: 'error', terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'overloaded' } };
}
