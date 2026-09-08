import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../../src/contracts/conversation-validation.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../../../helpers/row-policy-fixtures.js';
import { deterministicSummarySerialization } from '../../../helpers/summary-serialization.js';
import {
  EMPTY_COVERAGE_SUMMARY,
  SUMMARY_LEAF_INSTRUCTION,
  SUMMARY_REDUCTION_INSTRUCTION,
  createIncrementalSummaryMaterializer,
} from '../../../../src/runtime/actors/compaction/summary-materializer.js';
import type { CompactedHistory } from '../../../../src/schemas/index.js';
import type { SummarizerProviderPort } from '../../../../src/runtime/actors/compaction/summarizer.js';
import type { ProviderTurnCompletion } from '../../../../src/agents/llm-contracts.js';

const SESSION: ConversationSessionId = 'agent:planner:project';
const SOURCE_INPUT_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;
const BUDGET = { inputBudgetTokens: 100_000, completionReserveTokens: 20_000 };

type RecordedRequest = { instruction: string; items: string[]; admittedBytes: number };

function recordingProvider(args: { summaryOf: (request: RecordedRequest) => string; requests?: RecordedRequest[] }): SummarizerProviderPort {
  return {
    candidate: CANDIDATE,
    serializeSummaryRequest: deterministicSummarySerialization,
    completeTurn: async (input, admitted): Promise<ProviderTurnCompletion> => {
      const request: RecordedRequest = {
        instruction: input.systemPrompt,
        items: input.providerConversation.messages.map((row) => row.content),
        admittedBytes: Buffer.byteLength(admitted.serializedRequest, 'utf8'),
      };
      args.requests?.push(request);
      return { result: { kind: 'message' as const, content: args.summaryOf(request) }, provider_exchanges: [] };
    },
    projectProviderExchanges: jest.fn(),
  };
}

function conversationOf(rows: readonly AgentMessage[]) {
  return validateConversation(SESSION, [...rows]);
}

function activation(ordinal: number, inputId = SOURCE_INPUT_ID): AgentMessage {
  const timestamp = `2026-08-18T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  return agentMessageSchema.parse({
    id: `activation-${ordinal}`,
    session_id: SESSION,
    role: 'system',
    kind: 'activity',
    context_policy: ACTIVITY_ROW_POLICY,
    content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }),
    round_id: `r-pre-${String(ordinal).padStart(32, '0')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
  });
}

function text(id: string, content: string): AgentMessage {
  return agentMessageSchema.parse({
    id,
    session_id: SESSION,
    role: 'user',
    kind: 'text',
    context_policy: TEXT_ROW_POLICY,
    content,
    round_id: `r-user-${'2'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: '2026-08-18T00:00:01.000Z',
  });
}

function settledBundle(callId: string, body: string): AgentMessage[] {
  const result = JSON.stringify({ success: true, data: { content: body } });
  const policies = toolRowPolicies({ content: result });
  return [
    agentMessageSchema.parse({ id: `${SOURCE_INPUT_ID}:tool-call:${callId}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: callId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }), context_policy: policies.call, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 2, block_index: 0, timestamp: '2026-08-18T00:00:02.000Z' }),
    agentMessageSchema.parse({ id: `${SOURCE_INPUT_ID}:tool-result:${callId}`, session_id: SESSION, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: callId, content: result, context_policy: policies.result, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 3, block_index: 0, timestamp: '2026-08-18T00:00:03.000Z' }),
  ];
}

function inheritedHistory(summaryText: string): CompactedHistory {
  return {
    summaryText,
    source: { kind: 'current_rows', groups: [{ message_ids: ['seed'], content_sha256: '0'.repeat(64) }] },
    dispositionCommitment: { sha256: '0'.repeat(64), count: 1, summarized: 1, evidenceOnly: 0, superseded: 0 },
    coverageCommitment: { sourceSessionId: SESSION, sourceVersion: 1, coveredThroughMessageId: 'seed', coveredSourceGroupsSha256: '0'.repeat(64), accumulatedSummarySha256: '0'.repeat(64) },
    requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null },
  };
}

const materializeAllRows = (
  rows: readonly AgentMessage[],
  provider: SummarizerProviderPort,
  budget: { inputBudgetTokens: number; completionReserveTokens: number } = BUDGET,
  prior: CompactedHistory | null = null,
) =>
  createIncrementalSummaryMaterializer({ conversation: conversationOf(rows), inheritedHistory: prior, summarizerProvider: provider, budget, signal: new AbortController().signal })
    .materializeThrough(rows.length);

describe('bounded summary materialization', () => {
  it('packs the maximal ordered prefix per exact measured request and splits overflow into further requests', async () => {
    const rows = [activation(1), text('a', 'A'.repeat(3000)), text('b', 'B'.repeat(3000)), text('c', 'C'.repeat(3000))];
    const requests: RecordedRequest[] = [];
    const summary = await materializeAllRows(rows, recordingProvider({ requests, summaryOf: (r) => `s(${r.items.length})` }), {
      inputBudgetTokens: 4000,
      completionReserveTokens: 2000,
    });
    const leafRequests = requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION);
    expect(leafRequests.length).toBe(2);
    expect(leafRequests[0]!.items).toEqual([
      expect.stringContaining('[order 1/2] [kind=message source=a role=user semantic=direct]'),
      expect.stringContaining('[order 2/2] [kind=message source=b role=user semantic=direct]'),
    ]);
    expect(leafRequests[1]!.items).toEqual([
      expect.stringContaining('[order 1/1] [kind=message source=c role=user semantic=direct]'),
    ]);
    expect(summary).toContain('s(2)');
  });

  it('splits one oversized item by deterministic maximal-prefix UTF-8 chunks with part labels and identical results across runs', async () => {
    const body = 'ünïcödé-😀-'.repeat(4000);
    const rows = [activation(1), ...settledBundle('call-1', body)];
    const run = async (): Promise<RecordedRequest[]> => {
      const requests: RecordedRequest[] = [];
      await materializeAllRows(rows, recordingProvider({ requests, summaryOf: () => 'chunk-summary' }), {
        inputBudgetTokens: 5000,
        completionReserveTokens: 2500,
      });
      return requests;
    };
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    const chunks = first.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION);
    expect(chunks.length).toBeGreaterThan(1);
    const partLabels = chunks.map((request) => /\[part (\d+)\/(\d+)\]/.exec(request.items[0]!)!.slice(1, 3).join('/'));
    const total = partLabels[0]!.split('/')[1]!;
    expect(partLabels).toEqual(Array.from({ length: chunks.length }, (_, index) => `${index + 1}/${total}`));
    for (const request of chunks) {
      expect(Buffer.byteLength(request.items[0]!, 'utf8')).toBeLessThanOrEqual(4 * (5000 - 2000));
    }
    const reassembled = chunks.map((request) => request.items[0]!.split('\n').slice(1).join('\n')).join('');
    expect(reassembled).toBe(`tool_call_arguments={}\ntool_result_content=${JSON.stringify({ success: true, data: { content: body } })}`);
  });

  it('keeps the UTF-8 chunk boundary off code-point interiors', async () => {
    const rows = [activation(1), text('t1', 'é'.repeat(977))];
    const requests: RecordedRequest[] = [];
    await materializeAllRows(rows, recordingProvider({ requests, summaryOf: () => 'x' }), { inputBudgetTokens: 2200, completionReserveTokens: 2100 });
    const chunks = requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION);
    expect(chunks.length).toBeGreaterThan(1);
    const pieces = chunks.map((request) => request.items[0]!.split('\n').slice(1).join(''));
    for (const piece of pieces) expect(piece).toMatch(/^(é*)$/u);
    expect(pieces.join('')).toBe('é'.repeat(977));
  });

  it('measures labels, instruction, wrappers, prior history, and the completion reserve inside every admitted request', async () => {
    const rows = [activation(1), text('t1', 'T1'), text('t2', 'T2')];
    const requests: RecordedRequest[] = [];
    await materializeAllRows(rows, recordingProvider({ requests, summaryOf: (r) => `s:${r.items.join('|').slice(0, 24)}` }), { inputBudgetTokens: 4096, completionReserveTokens: 2048 }, inheritedHistory('PRIOR-HISTORY'));
    const leaf = requests.find((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION)!;
    expect(leaf.items.join('\n')).toContain('[kind=message source=t1 role=user semantic=direct]');
    expect(leaf.items.join('\n')).toContain('[kind=message source=t2 role=user semantic=direct]');
    const reduction = requests.find((request) => request.instruction === SUMMARY_REDUCTION_INSTRUCTION)!;
    expect(reduction.items.join('\n')).toContain('[kind=prior_accumulated_summary]');
    expect(reduction.items.join('\n')).toContain('PRIOR-HISTORY');
    for (const request of requests) {
      expect(request.admittedBytes).toBeGreaterThan(0);
      expect(Math.ceil(request.admittedBytes / 4) + 2000).toBeLessThanOrEqual(4096);
    }
  });

  it('reduces many leaf summaries sequentially until one final admitted summary remains', async () => {
    const rows = [activation(1)];
    for (let index = 1; index <= 6; index++) rows.push(text(`t${index}`, `BODY-${index}-`.repeat(400)));
    const requests: RecordedRequest[] = [];
    const final = await materializeAllRows(rows, recordingProvider({
      requests,
      summaryOf: (r) => r.instruction === SUMMARY_LEAF_INSTRUCTION ? `L(${r.items.length}):${'y'.repeat(200)}` : `R(${r.items.length}):${'z'.repeat(60)}`,
    }), { inputBudgetTokens: 4000, completionReserveTokens: 2000 });
    const leaf = requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION);
    expect(leaf.length).toBeGreaterThan(1);
    expect(final.startsWith('R(')).toBe(true);
  });

  it('fails before provider I/O when fixed overhead cannot fit the configured budget or reserve', async () => {
    const rows = [activation(1), text('t1', 'T1')];
    const calls: RecordedRequest[] = [];
    await expect(materializeAllRows(rows, recordingProvider({ requests: calls, summaryOf: () => 'x' }), { inputBudgetTokens: 2020, completionReserveTokens: 4000 })).rejects.toThrow(/fixed overhead/);
    await expect(materializeAllRows(rows, recordingProvider({ requests: calls, summaryOf: () => 'x' }), { inputBudgetTokens: 100_000, completionReserveTokens: 1999 })).rejects.toThrow(/completion reserve/);
    expect(calls).toHaveLength(0);
  });

  it('chunks oversized prior accumulated history and reduction outputs instead of failing', async () => {
    const rows = [activation(1), text('t1', 'SMALL')];
    const oversizedPrior = 'P'.repeat(40_000);
    const requests: RecordedRequest[] = [];
    const final = await materializeAllRows(rows, recordingProvider({ requests, summaryOf: (r) => r.items.join('').length > 1000 ? r.items.join('').slice(0, 500) : 'compact-final' }), { inputBudgetTokens: 5000, completionReserveTokens: 2500 }, inheritedHistory(oversizedPrior));
    const priorChunks = requests.filter((request) => request.instruction === SUMMARY_REDUCTION_INSTRUCTION && request.items.join('\n').includes('prior_accumulated_summary'));
    expect(priorChunks.length).toBeGreaterThanOrEqual(1);
    expect(final.length).toBeLessThan(oversizedPrior.length);
  });

  it('fails as a construction invariant when a reduction level does not shrink the measured aggregate', async () => {
    const rows = [activation(1), text('t1', 'BODY-ONE-'.repeat(300)), text('t2', 'BODY-TWO-'.repeat(300))];
    const identity = recordingProvider({ summaryOf: (r) => r.items.join('') });
    await expect(materializeAllRows(rows, identity, { inputBudgetTokens: 3000, completionReserveTokens: 2000 })).rejects.toThrow(/did not reduce the measured aggregate/);
  });

  it('returns the empty coverage summary for structural-only coverage without prior history', async () => {
    const rows = [activation(1)];
    const provider = recordingProvider({ summaryOf: () => 'x' });
    await expect(materializeAllRows(rows, provider)).resolves.toBe(EMPTY_COVERAGE_SUMMARY);
  });

  it('carries inherited history across structural-only coverage before materializing later content', async () => {
    const rows = [activation(1), text('t1', 'LATER-CONTENT')];
    const requests: RecordedRequest[] = [];
    const summaries = createIncrementalSummaryMaterializer({
      conversation: conversationOf(rows),
      inheritedHistory: inheritedHistory('PRIOR-HISTORY'),
      summarizerProvider: recordingProvider({
        requests,
        summaryOf: (request) => request.instruction === SUMMARY_LEAF_INSTRUCTION ? 'leaf-summary' : 'reduced-summary',
      }),
      budget: BUDGET,
      signal: new AbortController().signal,
    });

    await expect(summaries.materializeThrough(1)).resolves.toBe('PRIOR-HISTORY');
    expect(requests).toHaveLength(0);
    expect(summaries.materializedThrough).toBe(1);

    await expect(summaries.materializeThrough(2)).resolves.toBe('reduced-summary');
    expect(requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION)).toHaveLength(1);
    expect(requests.filter((request) => request.instruction === SUMMARY_REDUCTION_INSTRUCTION)).toHaveLength(1);
    expect(requests.flatMap((request) => request.items).filter((item) => item.includes('PRIOR-HISTORY'))).toHaveLength(1);
    expect(requests.flatMap((request) => request.items).join('\n')).toContain('LATER-CONTENT');
    expect(summaries.materializedThrough).toBe(2);
  });

  it('keeps repeated structural candidates outside the accumulator and excludes the sentinel from later provider input', async () => {
    const rows = [activation(1), activation(2), text('t1', 'CONTENT-AFTER-STRUCTURE')];
    const requests: RecordedRequest[] = [];
    const summaries = createIncrementalSummaryMaterializer({
      conversation: conversationOf(rows),
      inheritedHistory: null,
      summarizerProvider: recordingProvider({ requests, summaryOf: () => 'genuine-summary' }),
      budget: BUDGET,
      signal: new AbortController().signal,
    });
    await expect(summaries.materializeThrough(1)).resolves.toBe(EMPTY_COVERAGE_SUMMARY);
    await expect(summaries.materializeThrough(2)).resolves.toBe(EMPTY_COVERAGE_SUMMARY);
    await expect(summaries.materializeThrough(3)).resolves.toBe('genuine-summary');
    expect(requests.flatMap((request) => request.items).join('\n')).not.toContain(EMPTY_COVERAGE_SUMMARY);
    expect(requests.flatMap((request) => request.items).join('\n')).toContain('CONTENT-AFTER-STRUCTURE');
    expect(summaries.materializedThrough).toBe(3);
  });

  it('submits disjoint leaf increments and carries inherited content after a genuine summary across a structural advance', async () => {
    const rows = [activation(1), text('t1', 'FIRST-INCREMENT'), activation(2), text('t2', 'SECOND-INCREMENT'), activation(3)];
    const requests: RecordedRequest[] = [];
    const summaries = createIncrementalSummaryMaterializer({
      conversation: conversationOf(rows),
      inheritedHistory: inheritedHistory('PRIOR-HISTORY'),
      summarizerProvider: recordingProvider({ requests, summaryOf: (request) => request.instruction === SUMMARY_LEAF_INSTRUCTION ? `leaf-${requests.length}` : `reduced-${requests.length}` }),
      budget: BUDGET,
      signal: new AbortController().signal,
    });
    const first = await summaries.materializeThrough(2);
    await summaries.materializeThrough(4);
    const carried = await summaries.materializeThrough(5);
    const leafInputs = requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION).map((request) => request.items.join('\n'));
    expect(leafInputs.filter((input) => input.includes('FIRST-INCREMENT'))).toHaveLength(1);
    expect(leafInputs.filter((input) => input.includes('SECOND-INCREMENT'))).toHaveLength(1);
    expect(leafInputs.some((input) => input.includes('FIRST-INCREMENT') && input.includes('SECOND-INCREMENT'))).toBe(false);
    expect(requests.flatMap((request) => request.items).filter((input) => input.includes('PRIOR-HISTORY'))).toHaveLength(1);
    expect(carried).not.toBe(first);
    expect(requests.at(-1)!.instruction).toBe(SUMMARY_REDUCTION_INSTRUCTION);
  });

  it('leaves provider failure uncommitted and never overlaps calls', async () => {
    const structuralRows = [activation(1), text('t1', 'later')];
    let active = 0;
    let maximumActive = 0;
    let attempts = 0;
    const provider: SummarizerProviderPort = {
      candidate: CANDIDATE,
      serializeSummaryRequest: deterministicSummarySerialization,
      completeTurn: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        attempts++;
        await Promise.resolve();
        active--;
        if (attempts === 1) throw new Error('first summary failed');
        return { result: { kind: 'message' as const, content: 'recovered-summary' }, provider_exchanges: [] };
      },
      projectProviderExchanges: jest.fn(),
    };
    const retryable = createIncrementalSummaryMaterializer({ conversation: conversationOf(structuralRows), inheritedHistory: null, summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    await expect(retryable.materializeThrough(2)).rejects.toThrow('first summary failed');
    expect(retryable.materializedThrough).toBe(0);
    await expect(retryable.materializeThrough(2)).resolves.toBe('recovered-summary');
    expect(maximumActive).toBe(1);
    await expect(retryable.materializeThrough(2)).rejects.toThrow(/greater than 2/);
  });

  it('proves arbitrarily large diagnostic-shaped bodies need no envelope bound through chunked materialization', async () => {
    const body = 'DIAG-NOSTIC-'.repeat(50_000);
    const rows = [activation(1), ...settledBundle('call-huge', body)];
    const requests: RecordedRequest[] = [];
    const final = await materializeAllRows(rows, recordingProvider({ requests, summaryOf: (r) => `seg(${r.items.length})` }), { inputBudgetTokens: 6000, completionReserveTokens: 3000 });
    const chunks = requests.filter((request) => request.instruction === SUMMARY_LEAF_INSTRUCTION);
    expect(chunks.length).toBeGreaterThan(10);
    for (const request of chunks) expect(Math.ceil(request.admittedBytes / 4) + 2000).toBeLessThanOrEqual(6000);
    expect(typeof final).toBe('string');
    expect(final.length).toBeGreaterThan(0);
  });
});
