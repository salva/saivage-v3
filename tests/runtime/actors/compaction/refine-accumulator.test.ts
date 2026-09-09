import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../../src/contracts/conversation-validation.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../../../helpers/row-policy-fixtures.js';
import {
  createSequentialRefineAccumulator as createAccumulatorWithoutProgress,
  EMPTY_COVERAGE_SUMMARY,
  MAX_REFINE_INVOCATIONS,
  SummaryConstructionLimitError,
} from '../../../../src/runtime/actors/compaction/refine-accumulator.js';
import type { SummarizerProviderPort, SummaryRequestSerialization } from '../../../../src/runtime/actors/compaction/summarizer.js';
import { noCompactionProgress } from '../../../helpers/executing-llm-snapshot.js';

const createSequentialRefineAccumulator = (args: Omit<Parameters<typeof createAccumulatorWithoutProgress>[0], 'progress'>) => createAccumulatorWithoutProgress({ ...args, progress: noCompactionProgress });

const SESSION: ConversationSessionId = 'agent:planner:project';
const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;
const BUDGET = { inputBudgetTokens: 10_000, completionReserveTokens: 2_000 };
type SummaryInput = Parameters<SummarizerProviderPort['completeTurn']>[0];
type ParsedSummaryMessage = Readonly<{ label: string; body: string }>;

function parseSummaryMessages(input: SummaryInput): ParsedSummaryMessage[] {
  const messages = input.providerConversation.messages;
  return messages.map((message, index) => {
    const match = /^\[order (\d+)\/(\d+)\] ([^\n]+)\n([\s\S]*)$/u.exec(message.content);
    if (!match) throw new Error(`summary message ${index + 1} has an invalid wrapper`);
    expect(Number(match[1])).toBe(index + 1);
    expect(Number(match[2])).toBe(messages.length);
    return { label: match[3]!, body: match[4]! };
  });
}

describe('sequential contextual refine accumulator', () => {
  it('carries full prepared orientation and the genuine returned accumulator while ranges reassemble multibyte source exactly', async () => {
    const source = `before\u0000${'🙂'.repeat(4_000)}after`;
    const sent: Parameters<SummarizerProviderPort['completeTurn']>[0][] = [];
    const providerResults: string[] = [];
    const provider = recordingProvider({
      contextWindowTokens: 7_000,
      complete: async (input) => {
        sent.push(input);
        const result = `accumulator-${providerResults.length + 1}`;
        providerResults.push(result);
        return result;
      },
    });
    const rows = [activation(), text('source', source)];
    const accumulator = createSequentialRefineAccumulator({
      conversation: validateConversation(SESSION, rows),
      inheritedHistory: null,
      preparedBlocks: [{ id: 'card-context', role: 'system', content: 'FULL FROZEN CARD ORIENTATION', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }],
      summarizerProvider: provider,
      budget: BUDGET,
      signal: new AbortController().signal,
    });

    const materialized = await accumulator.materializeThrough(rows.length);
    expect(sent.length).toBeGreaterThan(1);
    expect(providerResults).toHaveLength(sent.length);
    expect(materialized).toBe(providerResults.at(-1));
    const parsedSent = sent.map(parseSummaryMessages);
    for (const messages of parsedSent) {
      const orientation = messages.filter(({ label }) => label === '[kind=current_observation source=card-context]');
      expect(orientation).toHaveLength(1);
      expect(orientation[0]!.body).toBe('FULL FROZEN CARD ORIENTATION');
      expect(messages.reduce(
        (count, { body }) => count + body.split('FULL FROZEN CARD ORIENTATION').length - 1,
        0,
      )).toBe(1);
    }
    for (let index = 1; index < parsedSent.length; index++) {
      const inheritedSummary = providerResults[index - 1]!;
      const inheritedHistory = parsedSent[index]!.filter(({ label }) => label === '[kind=inherited_history]');
      expect(inheritedHistory).toHaveLength(1);
      expect(inheritedHistory[0]!.body).toBe(inheritedSummary);
      expect(parsedSent[index]!.reduce(
        (count, { body }) => count + body.split(inheritedSummary).length - 1,
        0,
      )).toBe(1);
    }

    const ranges = parsedSent.flatMap((messages) => messages.flatMap(({ label, body }) => {
      if (!label.startsWith('[kind=new_source ') || !label.endsWith(']')) return [];
      const match = /(?:^| )range=(\d+):(\d+)(?= |\])/u.exec(label);
      return match ? [{ start: Number(match[1]), end: Number(match[2]), content: body }] : [];
    }));
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges.at(-1)!.end).toBe(Buffer.byteLength(source, 'utf8'));
    expect(ranges.every((entry, index) => index === 0 || entry.start === ranges[index - 1]!.end)).toBe(true);
    expect(ranges.map((entry) => entry.content).join('')).toBe(source);
  });

  it('allows sixteen logical calls and rejects a needed seventeenth before invoking it', async () => {
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'a' }, provider_exchanges: [] }));
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => serialization(input, sourceByteCount(input) > 1 ? 10_000 : 1),
      completeTurn,
    });
    const rows = [activation(), text('source', 'abcdefghijklmnopq')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    const failure = await accumulator.materializeThrough(rows.length).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SummaryConstructionLimitError);
    expect(failure).toMatchObject({ reason: 'fold_limit', invocationCount: MAX_REFINE_INVOCATIONS, invocationLimit: MAX_REFINE_INVOCATIONS });
    expect(completeTurn).toHaveBeenCalledTimes(MAX_REFINE_INVOCATIONS);
  });

  it('reports request context capacity only after the concrete next code point fails and sends nothing', async () => {
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unexpected' }, provider_exchanges: [] }));
    const provider = recordingProvider({ contextWindowTokens: 10_000, serialize: (input) => serialization(input, 10_000), completeTurn });
    const rows = [activation(), text('source', '🙂rest')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    const failure = await accumulator.materializeThrough(rows.length).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'request_context_capacity', invocationCount: 0, invocationLimit: MAX_REFINE_INVOCATIONS });
    expect(completeTurn).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted advance before a would-be minimum-range capacity failure or any effect', async () => {
    const reason = new Error('cancel before materialization');
    const controller = new AbortController();
    controller.abort(reason);
    const serializeSummaryRequest = jest.fn((input: SummaryInput) => serialization(input, 10_000));
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unexpected' }, provider_exchanges: [] }));
    const projectProviderExchanges = jest.fn();
    const foldStarted = jest.fn();
    const foldCompleted = jest.fn();
    const rows = [activation(), text('source', 'valid nonempty source')];
    const accumulator = createAccumulatorWithoutProgress({
      conversation: validateConversation(SESSION, rows),
      inheritedHistory: null,
      preparedBlocks: [],
      summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 10_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn, projectProviderExchanges },
      budget: BUDGET,
      signal: controller.signal,
      progress: { foldStarted, foldCompleted },
    });

    await expect(accumulator.materializeThrough(rows.length)).rejects.toBe(reason);
    expect(serializeSummaryRequest).not.toHaveBeenCalled();
    expect(completeTurn).not.toHaveBeenCalled();
    expect(projectProviderExchanges).not.toHaveBeenCalled();
    expect(foldStarted).not.toHaveBeenCalled();
    expect(foldCompleted).not.toHaveBeenCalled();
    expect(accumulator.materializedThrough).toBe(0);
    expect(accumulator.invocationCount).toBe(0);
  });

  it('does not resume packing after the first completed fold callback aborts', async () => {
    const reason = new Error('cancel from fold completion');
    const controller = new AbortController();
    let capacityFailureEnabled = false;
    const serializeSummaryRequest = jest.fn((input: SummaryInput) => serialization(
      input,
      capacityFailureEnabled || sourceByteCount(input) > 1 ? 10_000 : 1,
    ));
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'first summary' }, provider_exchanges: [] }));
    const projectProviderExchanges = jest.fn();
    const foldStarted = jest.fn();
    let serializationCountAtAbort = -1;
    const foldCompleted = jest.fn(() => {
      capacityFailureEnabled = true;
      serializationCountAtAbort = serializeSummaryRequest.mock.calls.length;
      controller.abort(reason);
    });
    const rows = [activation(), text('source', 'ab')];
    const accumulator = createAccumulatorWithoutProgress({
      conversation: validateConversation(SESSION, rows),
      inheritedHistory: null,
      preparedBlocks: [],
      summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 10_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn, projectProviderExchanges },
      budget: BUDGET,
      signal: controller.signal,
      progress: { foldStarted, foldCompleted },
    });

    await expect(accumulator.materializeThrough(rows.length)).rejects.toBe(reason);
    expect(foldStarted).toHaveBeenCalledTimes(1);
    expect(foldCompleted).toHaveBeenCalledTimes(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(projectProviderExchanges).toHaveBeenCalledTimes(1);
    expect(serializationCountAtAbort).toBeGreaterThan(0);
    expect(serializeSummaryRequest).toHaveBeenCalledTimes(serializationCountAtAbort);
    expect(accumulator.materializedThrough).toBe(0);
    expect(accumulator.invocationCount).toBe(1);
  });

  it('uses the existing post-await summarizer fence when a cancelled pending provider settles successfully', async () => {
    const reason = new Error('cancel while provider is pending');
    const controller = new AbortController();
    const serializeSummaryRequest = jest.fn((input: SummaryInput) => serialization(input, sourceByteCount(input) > 1 ? 10_000 : 1));
    let settleProvider!: () => void;
    const completeTurn = jest.fn(() => new Promise<Awaited<ReturnType<SummarizerProviderPort['completeTurn']>>>((resolve) => {
      settleProvider = () => resolve({ result: { kind: 'message' as const, content: 'settled summary' }, provider_exchanges: [] });
    }));
    const projectProviderExchanges = jest.fn();
    const foldStarted = jest.fn();
    const foldCompleted = jest.fn();
    const rows = [activation(), text('source', 'ab')];
    const accumulator = createAccumulatorWithoutProgress({
      conversation: validateConversation(SESSION, rows),
      inheritedHistory: null,
      preparedBlocks: [],
      summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 10_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn, projectProviderExchanges },
      budget: BUDGET,
      signal: controller.signal,
      progress: { foldStarted, foldCompleted },
    });

    const pending = accumulator.materializeThrough(rows.length);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    const serializationCountAtAbort = serializeSummaryRequest.mock.calls.length;
    controller.abort(reason);
    settleProvider();

    await expect(pending).rejects.toBe(reason);
    expect(foldStarted).toHaveBeenCalledTimes(1);
    expect(foldCompleted).not.toHaveBeenCalled();
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(projectProviderExchanges).toHaveBeenCalledTimes(1);
    expect(serializeSummaryRequest).toHaveBeenCalledTimes(serializationCountAtAbort);
    expect(accumulator.materializedThrough).toBe(0);
    expect(accumulator.invocationCount).toBe(1);
  });

  it('advances structural-only coverage with zero count without retaining the coverage sentinel', async () => {
    const completedInputs: SummaryInput[] = [];
    const completeTurn = jest.fn(async (input: SummaryInput) => {
      completedInputs.push(input);
      return { result: { kind: 'message' as const, content: 'genuine summary' }, provider_exchanges: [] };
    });
    const provider = recordingProvider({ contextWindowTokens: 10_000, completeTurn });
    const rows = [activation(), text('source', 'later source')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    await expect(accumulator.materializeThrough(1)).resolves.toBe(EMPTY_COVERAGE_SUMMARY);
    expect(accumulator.materializedThrough).toBe(1);
    expect(accumulator.invocationCount).toBe(0);
    expect(completeTurn).not.toHaveBeenCalled();
    await expect(accumulator.materializeThrough(2)).resolves.toBe('genuine summary');
    expect(accumulator.materializedThrough).toBe(2);
    expect(accumulator.invocationCount).toBe(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    const completedInput = completedInputs[0];
    if (!completedInput) throw new Error('Expected one completed summary input.');
    expect(completedInput.providerConversation.messages.some((message) => message.content.includes(EMPTY_COVERAGE_SUMMARY))).toBe(false);
  });
});

function recordingProvider(args: {
  contextWindowTokens: number;
  serialize?: SummarizerProviderPort['serializeSummaryRequest'];
  complete?: (input: Parameters<SummarizerProviderPort['completeTurn']>[0]) => Promise<string>;
  completeTurn?: SummarizerProviderPort['completeTurn'];
}): SummarizerProviderPort {
  return {
    candidate: CANDIDATE,
    contextWindowTokens: args.contextWindowTokens,
    maxOutputTokens: 10_000,
    serializeSummaryRequest: args.serialize ?? ((input) => serialization(input, Buffer.byteLength(JSON.stringify(input.providerConversation.messages), 'utf8') / 4)),
    completeTurn: args.completeTurn ?? (async (input) => ({ result: { kind: 'message' as const, content: await args.complete!(input) }, provider_exchanges: [] })),
    projectProviderExchanges: jest.fn(),
  };
}

function serialization(input: Parameters<SummarizerProviderPort['serializeSummaryRequest']>[0], estimatedInputTokens: number): SummaryRequestSerialization {
  const serializedRequest = JSON.stringify({ systemPrompt: input.systemPrompt, messages: input.providerConversation.messages });
  return { serializedRequest, requestSha256: createHash('sha256').update(serializedRequest).digest('hex'), estimatedInputTokens };
}

function sourceByteCount(input: Parameters<SummarizerProviderPort['serializeSummaryRequest']>[0]): number {
  return input.providerConversation.messages.reduce((total, item) => total + (item.content.includes('[kind=new_source ') ? Buffer.byteLength(item.content.split('\n').slice(1).join('\n'), 'utf8') : 0), 0);
}

function activation(): AgentMessage {
  const inputId = '11111111-1111-4111-8111-111111111111';
  const timestamp = '2026-09-08T00:00:00.000Z';
  return agentMessageSchema.parse({ id: 'activation', session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp });
}

function text(id: string, content: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content, round_id: `r-user-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-09-08T00:00:01.000Z' });
}
