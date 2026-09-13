import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';

import { validateConversation } from '../../../../src/contracts/conversation-validation.js';
import { agentMessageSchema, type AgentMessage, type ConversationSessionId } from '../../../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../../../helpers/row-policy-fixtures.js';
import {
  createSequentialRefineAccumulator as createAccumulatorWithoutProgress,
  EMPTY_COVERAGE_SUMMARY,
  MAX_REFINE_INVOCATIONS,
  SUMMARY_REFINE_INSTRUCTION,
  SummaryConstructionLimitError,
} from '../../../../src/runtime/actors/compaction/refine-accumulator.js';
import { SUMMARY_OUTPUT_TARGET_BYTES, type SummarizerProviderPort, type SummaryRequestSerialization } from '../../../../src/runtime/actors/compaction/summarizer.js';
import { noCompactionProgress } from '../../../helpers/executing-llm-snapshot.js';
import { buildCandidateRequest } from '../../../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../../../src/agents/llm-protocol-adapter.js';

const createSequentialRefineAccumulator = (args: Omit<Parameters<typeof createAccumulatorWithoutProgress>[0], 'progress'>) => createAccumulatorWithoutProgress({ ...args, progress: noCompactionProgress });

const SESSION: ConversationSessionId = 'agent:planner:project';
const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;
const BUDGET = { contextUtilizationFraction: 0.8 };
type SummaryInput = Parameters<SummarizerProviderPort['completeTurn']>[0];
type ParsedSummaryMessage = Readonly<{ label: string; body: string }>;
type ParsedSourceRange = Readonly<{
  source: string;
  sourceKind: string;
  start: number;
  end: number;
  totalBytes: number;
  sourceSha256: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

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
      const orientation = messages.filter(({ label }) => label === '[kind=prepared_context source=card-context]');
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

  it('preserves exact projected source semantics for mixed Unicode and legitimate empty tool components', async () => {
    const mixed = `A\u0000é中🙂\uD800B\uDC00Z`;
    const settledResult = '{"success":true}';
    const emptyBundles = Array.from({ length: 12 }, (_, index) => settledToolRows(`empty-call-${index + 1}`, 2 + index * 2, '', settledResult)).flat();
    const rows = [
      activation(),
      text('mixed-source', mixed),
      ...emptyBundles,
    ];
    const sent: SummaryInput[] = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      complete: async (input) => {
        sent.push(input);
        return `summary-${sent.length}`;
      },
    });
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });

    await accumulator.materializeThrough(rows.length);

    const ranges = sent.flatMap(sourceRanges);
    const expectedSources = [
      { source: 'mixed-source', sourceKind: 'message:direct', role: 'user' as const, content: mixed },
      ...Array.from({ length: 12 }, (_, index) => {
        const callId = `empty-call-${index + 1}`;
        return [
          { source: `11111111-1111-4111-8111-111111111111:${callId}:arguments`, sourceKind: 'tool_arguments:empty_tool', role: 'assistant' as const, content: '' },
          { source: `11111111-1111-4111-8111-111111111111:${callId}:result`, sourceKind: 'tool_result:empty_tool', role: 'user' as const, content: settledResult },
        ];
      }).flat(),
    ];
    expect(ranges.filter((entry, index) => index === 0 || entry.source !== ranges[index - 1]!.source).map((entry) => entry.source)).toEqual(expectedSources.map(({ source }) => source));
    for (const expected of expectedSources) {
      const sourceRangesInOrder = ranges.filter(({ source }) => source === expected.source);
      expect(sourceRangesInOrder).not.toHaveLength(0);
      expect(sourceRangesInOrder[0]!.start).toBe(0);
      expect(sourceRangesInOrder.at(-1)!.end).toBe(Buffer.byteLength(expected.content, 'utf8'));
      expect(sourceRangesInOrder.every((entry, index) => index === 0 || entry.start === sourceRangesInOrder[index - 1]!.end)).toBe(true);
      expect(sourceRangesInOrder.map(({ content }) => content).join('')).toBe(expected.content);
      for (const range of sourceRangesInOrder) {
        expect(range).toMatchObject({
          sourceKind: expected.sourceKind,
          role: expected.role,
          totalBytes: Buffer.byteLength(expected.content, 'utf8'),
          sourceSha256: sourceHash(expected.content),
        });
        expect(Buffer.byteLength(range.content, 'utf8')).toBe(range.end - range.start);
      }
    }
    expect(ranges.filter(({ content }) => content === '')).toHaveLength(12);
  });

  it('stops at the first rejected growth probe, resumes at the admitted endpoint, and sends the exact admitted objects', async () => {
    const attempts: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization; range: string }> = [];
    const completed: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization }> = [];
    const estimateForRange = (range: string): number => {
      if (range === '0:9' || range === '0:4') return 10_000;
      return 1;
    };
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => {
        const range = onlySourceRange(input);
        const result = serialization(input, estimateForRange(range));
        attempts.push({ input, serialization: result, range });
        return result;
      },
      completeTurn: async (input, admitted) => {
        completed.push({ input, serialization: admitted });
        return { result: { kind: 'message' as const, content: `summary-${completed.length}` }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'abcdefghi')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });

    await accumulator.materializeThrough(rows.length);

    expect(attempts.map(({ range }) => range)).toEqual(['0:1', '0:9', '0:2', '0:4', '0:3', '3:4', '3:9']);
    expect(estimateForRange('0:8')).toBe(1);
    expect(completed).toHaveLength(2);
    expect(completed[0]!.input).toBe(attempts[4]!.input);
    expect(completed[0]!.serialization).toBe(attempts[4]!.serialization);
    expect(onlySourceRange(completed[0]!.input)).toBe('0:3');
    expect(attempts.find(({ range }) => range === '0:4')!.serialization.estimatedInputTokens).toBeGreaterThan(8_000 - 2_000);
    expect(completed[1]!.input).toBe(attempts[6]!.input);
    expect(completed[1]!.serialization).toBe(attempts[6]!.serialization);
    expect(onlySourceRange(completed[1]!.input)).toBe('3:9');
  });

  it('refines actual JSON wire admission across escaping, supplementary characters, and range-label digit transitions until the next code point rejects', async () => {
    const capabilities = { transportProtocol: 'openai-chat-completions' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, contextWindowTokens: 4_000, maxOutputTokens: 10_000, quirks: [] };
    const attempts: Array<{ range: ParsedSourceRange; serialization: SummaryRequestSerialization }> = [];
    const sent: SummaryInput[] = [];
    const provider = recordingProvider({
      contextWindowTokens: capabilities.contextWindowTokens,
      serialize: (input) => {
        const plan = buildCandidateRequest({ candidate: CANDIDATE, capabilities, adapter: selectLlmProtocolAdapter(capabilities.transportProtocol), systemPrompt: input.systemPrompt, providerConversation: input.providerConversation, options: { inputId: input.inputId, temperature: 0, max_tokens: 2_000, tools: [], tool_choice: 'auto', contract_id: 'internal-compaction-summary.v1', contractName: 'internal-compaction-summary', terminalToolOffered: [] } });
        const result = { serializedRequest: plan.request.serializedBody, requestSha256: plan.request.requestHash, estimatedInputTokens: plan.request.estimatedWireInputTokens };
        const ranges = sourceRanges(input);
        if (ranges.length === 1) attempts.push({ range: ranges[0]!, serialization: result });
        return result;
      },
      complete: async (input) => { sent.push(input); return `summary-${sent.length}`; },
    });
    const source = (`ASCII "quoted" \\ slash\ncontrol\té漢🙂-${'x'.repeat(31)}|`).repeat(180);
    const rows = [activation(), text('source', source)];

    await createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal }).materializeThrough(rows.length);

    const admittedRanges = sent.flatMap(sourceRanges);
    expect(admittedRanges.length).toBeGreaterThan(1);
    expect(admittedRanges.map(({ content }) => content).join('')).toBe(source);
    expect(attempts.some(({ range }) => range.start === 0 && range.end === 8)).toBe(true);
    expect(attempts.some(({ range }) => range.start === 0 && range.end >= 10)).toBe(true);
    const inputCapacity = Math.floor(0.8 * capabilities.contextWindowTokens) - 2_000;
    for (const admitted of admittedRanges.slice(0, -1)) {
      const prefix = Buffer.from(source, 'utf8').subarray(0, admitted.end).toString('utf8');
      const nextPoint = source.codePointAt(prefix.length)!;
      const nextEnd = admitted.end + Buffer.byteLength(String.fromCodePoint(nextPoint), 'utf8');
      const rejection = attempts.find(({ range }) => range.start === admitted.start && range.end === nextEnd);
      expect(rejection?.serialization.estimatedInputTokens).toBeGreaterThan(inputCapacity);
    }
    for (let index = 1; index < attempts.length; index++) {
      const previous = attempts[index - 1]!;
      const current = attempts[index]!;
      if (previous.range.start === current.range.start && previous.range.end < current.range.end)
        expect(current.serialization.estimatedInputTokens).toBeGreaterThanOrEqual(previous.serialization.estimatedInputTokens);
    }
  });

  it('retains the distinct fitting whole-width doubling probe at an eight-code-point EOF', async () => {
    const attempts: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization }> = [];
    const completed: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization }> = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => {
        const result = serialization(input, attempts.length === 1 ? 10_000 : 1);
        attempts.push({ input, serialization: result });
        return result;
      },
      completeTurn: async (input, admitted) => {
        completed.push({ input, serialization: admitted });
        return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'abcdefgh')];

    await createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal }).materializeThrough(rows.length);

    expect(attempts.map(({ input }) => onlySourceRange(input))).toEqual(['0:1', '0:8', '0:2', '0:4', '0:8']);
    expect(attempts[1]!.input).not.toBe(attempts[4]!.input);
    expect(attempts[1]!.serialization).not.toBe(attempts[4]!.serialization);
    expect(attempts[1]!.input.providerConversation.messages).toEqual(attempts[4]!.input.providerConversation.messages);
    expect(sourceRanges(attempts[1]!.input)).toEqual([{
      source: 'source',
      sourceKind: 'message:direct',
      start: 0,
      end: 8,
      totalBytes: 8,
      sourceSha256: sourceHash('abcdefgh'),
      role: 'user',
      content: 'abcdefgh',
    }]);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.input).toBe(attempts[4]!.input);
    expect(completed[0]!.serialization).toBe(attempts[4]!.serialization);
  });

  it('does not add a clamped width-eight probe at a seven-code-point EOF', async () => {
    const attempts: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization }> = [];
    const completed: Array<{ input: SummaryInput; serialization: SummaryRequestSerialization }> = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => {
        const result = serialization(input, attempts.length === 1 ? 10_000 : 1);
        attempts.push({ input, serialization: result });
        return result;
      },
      completeTurn: async (input, admitted) => {
        completed.push({ input, serialization: admitted });
        return { result: { kind: 'message' as const, content: `summary-${completed.length}` }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'abcdefg')];

    await createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal }).materializeThrough(rows.length);

    expect(attempts.slice(0, 4).map(({ input }) => onlySourceRange(input))).toEqual(['0:1', '0:7', '0:2', '0:4']);
    expect(onlySourceRange(completed[0]!.input)).toBe('0:6');
    expect(onlySourceRange(completed[1]!.input)).toBe('6:7');
    expect(attempts.map(({ input }) => onlySourceRange(input)).filter((range) => range === '0:7')).toHaveLength(1);
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

  it('regenerates one invalid fold from identical source and pre-fold inheritance with a fresh stronger request', async () => {
    const inputs: SummaryInput[] = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      completeTurn: async (input) => {
        inputs.push(input);
        return { result: { kind: 'message' as const, content: inputs.length === 1 ? '   ' : 'corrected' }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'exact source')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });

    await expect(accumulator.materializeThrough(rows.length)).resolves.toBe('corrected');
    expect(accumulator.invocationCount).toBe(2);
    expect(accumulator.correctionCount).toBe(1);
    expect(inputs[1]!.inputId).not.toBe(inputs[0]!.inputId);
    expect(inputs[1]!.systemPrompt).toContain('6000 UTF-8 bytes');
    expect(inputs[1]!.providerConversation.messages).toEqual(inputs[0]!.providerConversation.messages);
  });

  it('gives normal and corrective refinement the same evidence and state distinctions without copying prepared context', async () => {
    const inputs: SummaryInput[] = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      completeTurn: async (input) => {
        inputs.push(input);
        return { result: { kind: 'message' as const, content: inputs.length === 1 ? ' ' : 'corrected' }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'Owner constraint and an unrecorded observed finding.')];
    const accumulator = createSequentialRefineAccumulator({
      conversation: validateConversation(SESSION, rows),
      inheritedHistory: null,
      preparedBlocks: [{ id: 'node', role: 'system', content: 'CURRENT NODE', storage: 'activation_local', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }],
      summarizerProvider: provider,
      budget: BUDGET,
      signal: new AbortController().signal,
    });

    await expect(accumulator.materializeThrough(rows.length)).resolves.toBe('corrected');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(parseSummaryMessages(input).filter(({ label }) => label === '[kind=prepared_context source=node]').map(({ body }) => body)).toEqual(['CURRENT NODE']);
    }
    expect(inputs[0]!.systemPrompt).toBe(SUMMARY_REFINE_INSTRUCTION);
    expect(inputs[1]!.systemPrompt).toBe(SUMMARY_REFINE_INSTRUCTION.replace(String(SUMMARY_OUTPUT_TARGET_BYTES), '6000'));
  });

  it('corrects the last genuine fold when its output blocks the next minimum source range and resumes at the unconsumed cursor', async () => {
    const sent: SummaryInput[] = [];
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => {
        const inherited = input.providerConversation.messages.find((message) => message.content.includes('[kind=inherited_history]'))?.content ?? '';
        const sourceBytes = sourceByteCount(input);
        return serialization(input, inherited.includes('X'.repeat(100)) && sourceBytes > 0 ? 10_000 : sourceBytes > 1 ? 10_000 : 1);
      },
      completeTurn: async (input) => {
        sent.push(input);
        return { result: { kind: 'message' as const, content: input.systemPrompt.includes('6000 UTF-8 bytes') ? 'short' : 'X'.repeat(100) }, provider_exchanges: [] };
      },
    });
    const rows = [activation(), text('source', 'ab')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });

    await expect(accumulator.materializeThrough(rows.length)).resolves.toBe('X'.repeat(100));
    expect(accumulator.correctionCount).toBe(1);
    expect(sent.map(onlySourceRange)).toEqual(['0:1', '0:1', '1:2']);
    expect(sent[1]!.providerConversation.messages).toEqual(sent[0]!.providerConversation.messages);
  });

  it('counts fifteen normal folds plus one incomplete fold and blocks its correction before a seventeenth send', async () => {
    let calls = 0;
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: ++calls === 16 ? ' ' : `summary-${calls}` }, provider_exchanges: [] }));
    const provider = recordingProvider({ contextWindowTokens: 10_000, serialize: (input) => serialization(input, sourceByteCount(input) > 1 ? 10_000 : 1), completeTurn });
    const rows = [activation(), text('source', 'abcdefghijklmnop')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    const failure = await accumulator.materializeThrough(rows.length).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'fold_limit', invocationCount: 16, invocationLimit: 16 });
    expect(accumulator.correctionCount).toBe(1);
    expect(completeTurn).toHaveBeenCalledTimes(16);
  });

  it('consumes the one correction but sends nothing when its fresh stronger request is not admitted', async () => {
    const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: ' ' }, provider_exchanges: [] }));
    const provider = recordingProvider({
      contextWindowTokens: 10_000,
      serialize: (input) => serialization(input, input.systemPrompt.includes('6000 UTF-8 bytes') ? 10_000 : 1),
      completeTurn,
    });
    const rows = [activation(), text('source', 'a')];
    const accumulator = createSequentialRefineAccumulator({ conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks: [], summarizerProvider: provider, budget: BUDGET, signal: new AbortController().signal });
    const failure = await accumulator.materializeThrough(rows.length).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'request_context_capacity', invocationCount: 1 });
    expect(accumulator.correctionCount).toBe(1);
    expect(completeTurn).toHaveBeenCalledTimes(1);
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
      progress: { foldStarted, foldCompleted, foldFailed: jest.fn() },
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
      progress: { foldStarted, foldCompleted, foldFailed: jest.fn() },
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
      progress: { foldStarted, foldCompleted, foldFailed: jest.fn() },
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

function sourceRanges(input: SummaryInput): ParsedSourceRange[] {
  return input.providerConversation.messages.flatMap((message) => {
    const wrapper = /^\[order \d+\/\d+\] ([^\n]+)\n([\s\S]*)$/u.exec(message.content);
    if (!wrapper?.[1].startsWith('[kind=new_source ')) return [];
    const label = /^\[kind=new_source source=(\S+) source_kind=(\S+) range=(\d+):(\d+) total_bytes=(\d+) source_sha256=([0-9a-f]{64}) omitted_source_bytes=0\]$/u.exec(wrapper[1]);
    if (!label) throw new Error(`Invalid new-source label: ${wrapper[1]}`);
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') throw new Error(`Invalid new-source role: ${message.role}`);
    return [{
      source: label[1]!,
      sourceKind: label[2]!,
      start: Number(label[3]),
      end: Number(label[4]),
      totalBytes: Number(label[5]),
      sourceSha256: label[6]!,
      role: message.role,
      content: wrapper[2]!,
    }];
  });
}

function onlySourceRange(input: SummaryInput): string {
  const ranges = sourceRanges(input);
  if (ranges.length !== 1) throw new Error(`Expected one source range, received ${ranges.length}.`);
  return `${ranges[0]!.start}:${ranges[0]!.end}`;
}

function sourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function activation(): AgentMessage {
  const inputId = '11111111-1111-4111-8111-111111111111';
  const timestamp = '2026-09-08T00:00:00.000Z';
  return agentMessageSchema.parse({ id: 'activation', session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp });
}

function text(id: string, content: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content, round_id: `r-user-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-09-08T00:00:01.000Z' });
}

function settledToolRows(callId: string, firstMessageIndex: number, argumentsJson: string, resultContent: string): AgentMessage[] {
  const sourceInputId = '11111111-1111-4111-8111-111111111111';
  const roundId = `r-user-${'1'.repeat(32)}`;
  const policies = toolRowPolicies({ content: resultContent });
  return [
    agentMessageSchema.parse({
      id: `${sourceInputId}:tool-call:${callId}`,
      session_id: SESSION,
      role: 'assistant',
      kind: 'tool_call',
      tool: 'empty_tool',
      tool_call_id: callId,
      context_policy: policies.call,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'empty_tool', arguments: argumentsJson } }] }),
      round_id: roundId,
      message_index: firstMessageIndex,
      block_index: 0,
      timestamp: '2026-09-08T00:00:02.000Z',
    }),
    agentMessageSchema.parse({
      id: `${sourceInputId}:tool-result:${callId}`,
      session_id: SESSION,
      role: 'tool',
      kind: 'tool_result',
      tool: 'empty_tool',
      tool_call_id: callId,
      context_policy: policies.result,
      content: resultContent,
      round_id: roundId,
      message_index: firstMessageIndex + 1,
      block_index: 0,
      timestamp: '2026-09-08T00:00:03.000Z',
    }),
  ];
}
