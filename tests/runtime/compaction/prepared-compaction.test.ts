import { describe, expect, it, jest } from '@jest/globals';

import { prepareCompaction, shouldCompact, type CompactionConfig } from '../../../src/runtime/actors/compaction/compactor.js';
import { classifyConversationRounds, estimateMessageTokens } from '../../../src/runtime/actors/compaction/round-classifier.js';
import { computeSlidingCompactionBands } from '../../../src/runtime/actors/compaction/bands.js';
import { agentMessageSchema, type AgentMessage } from '../../../src/schemas/index.js';
import type { LlmInvocationInput, PreparedCompaction } from '../../../src/runtime/actors/llm-invocation.js';
import { summarizeMerge, summarizeRound } from '../../../src/runtime/actors/compaction/summarizer.js';
import { buildOpenAIResponsesRequest } from '../../../src/agents/llm-openai-responses-gateway.js';

const config: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };

describe('prepared compaction estimates', () => {
  it('derives every activation policy quantity once from the exact prompt and tools', () => {
    const prepared = prepareCompaction(config, 'system', []);
    expect(prepared).toMatchObject({ inputBudgetTokens: 1000, requestedCompletionTokens: 200, triggerLineTokens: 800, normalTailBudget: 300, normalMiddleBudget: 200, escalatedTailBudget: 250, escalatedMiddleBudget: 150, summarizerModel: 'test/_/summary' });
    expect(prepared.triggerMessageThreshold).toBe(prepared.triggerLineTokens - prepared.estimatedStaticTokens);
    expect(prepared.canonicalMessageHardCeiling).toBe(prepared.inputBudgetTokens - prepared.estimatedStaticTokens - prepared.requestedCompletionTokens);
  });

  it('triggers exactly at the prepared boundary while hidden rows remain zero and Unicode keeps UTF-16 sizing', () => {
    const hidden = message('hidden', 'system', 'activity', 'x'.repeat(1000));
    const unicode = message('unicode', 'user', 'text', '😀😀');
    expect(estimateMessageTokens(hidden)).toBe(0);
    expect(estimateMessageTokens(unicode)).toBe(Math.max(1, Math.ceil((unicode.content.length + ['user', 'text', unicode.round_id].join(' ').length) / 4)));
    const visibleTokens = estimateMessageTokens(unicode);
    const base = prepareCompaction(config, 'system', []);
    expect(shouldCompact(invocation([hidden, unicode], { ...base, triggerMessageThreshold: visibleTokens }))).toBe(true);
    expect(shouldCompact(invocation([hidden, unicode], { ...base, triggerMessageThreshold: visibleTokens + 1 }))).toBe(false);
  });

  it('gives provider-private rows zero actor weight while their visible projection remains counted', () => {
    const privateRow = message('private', 'system', 'provider_private', 'x'.repeat(100_000));
    const visible = message('visible', 'assistant', 'text', 'visible');
    expect(estimateMessageTokens(privateRow)).toBe(0);
    expect(estimateMessageTokens(visible)).toBeGreaterThan(0);
    const base = prepareCompaction(config, 'system', []);
    expect(shouldCompact(invocation([privateRow], { ...base, triggerMessageThreshold: 1 }))).toBe(false);
    expect(shouldCompact(invocation([privateRow, visible], { ...base, triggerMessageThreshold: estimateMessageTokens(visible) }))).toBe(true);
    const activation = message('activation', 'system', 'activity', JSON.stringify({ event: 'activation_open' }));
    const withoutPrivate = classifyConversationRounds([activation, visible]);
    const withPrivate = classifyConversationRounds([activation, privateRow, visible]);
    expect(withPrivate.rounds[0]!.estimated_tokens).toBe(withoutPrivate.rounds[0]!.estimated_tokens);
    const bands = (rounds: typeof withPrivate.rounds) => {
      const selected = computeSlidingCompactionBands(rounds, { tail_budget_tokens: 0, middle_budget_tokens: 0, snap: 'compact_straddler' });
      return { merge: selected.merge_rounds.map((round) => round.round_id), summary: selected.summary_rounds.map((round) => round.round_id), tail: selected.tail_rounds.map((round) => round.round_id), open: selected.open_round?.round_id };
    };
    expect(bands(withPrivate.rounds)).toEqual(bands(withoutPrivate.rounds));
  });

  it('classifies each source row with one estimate and stores only the consumed round aggregate', () => {
    const marker = message('marker', 'system', 'activity', JSON.stringify({ event: 'activation_open' }));
    const first = message('first', 'user', 'text', 'first');
    const second = message('second', 'assistant', 'text', 'second');
    const classified = classifyConversationRounds([marker, first, second]);
    expect(classified).not.toHaveProperty('total_estimated_tokens');
    expect(classified.rounds[0]).not.toHaveProperty('start_token');
    expect(classified.rounds[0]).not.toHaveProperty('end_token');
    expect(classified.rounds[0]!.rows.every((row) => !('start_token' in row) && !('end_token' in row))).toBe(true);
    expect(classified.rounds[0]!.estimated_tokens).toBe(classified.rounds[0]!.rows.reduce((sum, row) => sum + row.estimated_tokens, 0));
  });

  it('partitions from the retained round aggregate without changing boundaries', () => {
    const rounds = [10, 10, 10, 10, 10].map((estimated_tokens, index) => ({ round_id: `r${index}`, activation_marker: { message: message(`m${index}`, 'system', 'activity', ''), estimated_tokens: 0 }, rows: [], sub_rounds: [], estimated_tokens }));
    const bands = computeSlidingCompactionBands(rounds, { tail_budget_tokens: 20, middle_budget_tokens: 10, snap: 'compact_straddler' });
    expect(bands.merge_rounds.map((round) => round.round_id)).toEqual(['r0']);
    expect(bands.summary_rounds.map((round) => round.round_id)).toEqual(['r1']);
    expect(bands.tail_rounds.map((round) => round.round_id)).toEqual(['r2', 'r3']);
    expect(bands.open_round?.round_id).toBe('r4');
  });

  it('keeps round and merge summarizers on the ordinary 2000-token contract', async () => {
    const inputs: LlmInvocationInput[] = [];
    const summarizerProvider = { completeTurn: async (input: LlmInvocationInput) => { inputs.push(input); return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }; } };
    const signal = new AbortController().signal;
    await summarizeRound({ sourceSessionId: 'planner:project', round_id: 'round', rows: [message('source', 'user', 'text', 'source')], summarizerProvider, modelSpec: 'test/_/summary', signal });
    await summarizeMerge({ entries: [{ round_id: 'round', summary_text: 'summary' }], summarizerProvider, modelSpec: 'test/_/summary', signal });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.sessionId).toBe('summary:round');
    expect(inputs[0]!.providerConversation.sourceSessionId).toBe('planner:project');
    expect(inputs[0]!.providerConversation.messages[0]).toMatchObject({ id: 'source', session_id: 'planner:project' });
    expect(inputs[0]!.inputId).not.toBe(inputs[0]!.providerConversation.messages[0]!.id);
    expect(inputs[1]!.providerConversation.sourceSessionId).toBe('summary:merge');
    for (const input of inputs) {
      expect(input.preparedCompaction).toBeUndefined();
      expect(input.modelParams.maxTokens).toBe(2000);
    }
  });

  it('admits a non-persisting distinct-identity round summary with an intact private/visible pair', async () => {
    const rows = privatePair();
    const inputs: LlmInvocationInput[] = [];
    const summarizerProvider = { completeTurn: async (input: LlmInvocationInput) => {
      inputs.push(input);
      const body = buildOpenAIResponsesRequest({ provider: 'openai', account: null, model: 'gpt-5.6' }, input.systemPrompt, input.providerConversation, { inputId: input.inputId, phase: 'tools', contract_id: 'summary', contractName: 'summary', terminalToolOffered: [], tools: [], tool_choice: { kind: 'auto' } });
      expect(JSON.stringify(body.input)).toContain('private summary source');
      return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
    } };

    await expect(summarizeRound({ sourceSessionId: 'planner:project', round_id: 'round', rows, summarizerProvider, modelSpec: 'test/_/summary', signal: new AbortController().signal })).resolves.toBe('summary');

    const input = inputs[0]!;
    expect(input.sessionId).toBe('summary:round');
    expect(input.providerConversation.sourceSessionId).toBe('planner:project');
    expect(input.sessionId).not.toBe(input.providerConversation.sourceSessionId);
    expect(input.providerConversation.messages).toEqual(rows);
    expect(input.inputId).not.toBe(rows[0]!.id);
  });

  it.each([
    ['wrong source session', (rows: AgentMessage[]) => [{ ...rows[0]!, session_id: 'planner:other' }, rows[1]!]],
    ['missing private row', (rows: AgentMessage[]) => [rows[1]!]],
    ['missing visible row', (rows: AgentMessage[]) => [rows[0]!]],
    ['mismatched source input', (rows: AgentMessage[]) => [rows[0]!, { ...rows[1]!, provider_projection: { ...rows[1]!.provider_projection!, source_input_id: 'different-input' } }]],
    ['inconsistent mutual ids', (rows: AgentMessage[]) => [{ ...rows[0]!, content: JSON.stringify({ ...JSON.parse(rows[0]!.content), projection_message_id: 'different-visible' }) }, rows[1]!]],
  ] as Array<[string, (rows: AgentMessage[]) => AgentMessage[]]>)('rejects %s before the round summarizer provider call', async (_label, mutate) => {
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
    const rows = mutate(privatePair());
    await expect(summarizeRound({ sourceSessionId: 'planner:project', round_id: 'round', rows, summarizerProvider: { completeTurn }, modelSpec: 'test/_/summary', signal: new AbortController().signal })).rejects.toThrow();
    expect(completeTurn).not.toHaveBeenCalled();
    expect(rows).toEqual(mutate(privatePair()));
  });

  it('excludes compaction metadata from later summary input and merges only explicit summary values', async () => {
    const completeTurn = jest.fn(async (_input: LlmInvocationInput) => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }));
    const metadata = { ...message('metadata', 'system', 'text', '{}'), kind: 'context_compaction' as const };
    await expect(summarizeRound({ sourceSessionId: 'planner:project', round_id: 'round', rows: [metadata], summarizerProvider: { completeTurn }, modelSpec: 'test', signal: new AbortController().signal })).rejects.toThrow(/immutable non-metadata/);
    await summarizeMerge({ entries: [{ round_id: 'old', summary_text: 'explicit prior summary' }], summarizerProvider: { completeTurn }, modelSpec: 'test', signal: new AbortController().signal });
    expect(completeTurn).toHaveBeenCalledTimes(1);
    const mergeInput = completeTurn.mock.calls[0]![0];
    expect(JSON.stringify(mergeInput.providerConversation.messages)).toContain('explicit prior summary');
    expect(JSON.stringify(mergeInput.providerConversation.messages)).not.toContain('context_compaction');
  });
});

function invocation(contextMessages: AgentMessage[], preparedCompaction: PreparedCompaction): LlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: contextMessages }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction, capabilityRequest: {}, episodeContext: {} };
}

function message(id: string, role: AgentMessage['role'], kind: AgentMessage['kind'], content: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: 'planner:project', role, kind, content, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' });
}

function privatePair(): AgentMessage[] {
  const sourceInputId = '11111111-1111-4111-8111-111111111111';
  const privateRow = agentMessageSchema.parse({ ...message('private-summary', 'system', 'provider_private', JSON.stringify({ transport: 'openai-responses', source_input_id: sourceInputId, projection_message_id: 'visible-summary', provider: 'openai', model: 'gpt-5.6', output: [{ type: 'message', content: [{ type: 'output_text', text: 'private summary source' }] }] })) });
  const visible = agentMessageSchema.parse({ ...message('visible-summary', 'assistant', 'text', 'visible summary source'), provider_projection: { kind: 'openai_responses', source_input_id: sourceInputId, private_message_id: privateRow.id, projection_kind: 'assistant_message' } });
  return [privateRow, visible];
}
