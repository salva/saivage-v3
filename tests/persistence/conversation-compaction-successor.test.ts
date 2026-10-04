import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { cardConversationVersionIndexFile, conversationPreviousIndexFile } from '../../src/persistence/layout.js';
import { createHash } from 'node:crypto';
import { conversationSegmentEnvelopeSchema } from '../../src/persistence/canonical-conversation-artifacts.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, initializeConversation, readConversation, readConversationCatalog, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { compact as compactWithoutProgress, prepareCompaction, type AutonomousCompactionPolicy, type CompactArgs, type CompactionResult } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { ConversationSessionIdSchema, globalAgentSessionId, canonicalJson, canonicalValueSha256, type AgentMessage, type CompactedHistory, type ConversationSessionId } from '../../src/schemas/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { type SummaryRequestSerialization, type SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { internalCompactionSummarySessionId } from '../../src/contracts/provider-exchange-log.js';
import { validateCompactedHistorySuccessor, type ValidatedConversation } from '../../src/contracts/conversation-validation.js';
import { publishFreshFile } from '../../src/persistence/replace-file.js';
import { publicationWitness, type PublicationFault } from '../helpers/segment-publication-io.js';
import { publishHeadFile } from '../../src/persistence/publish-head.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ProviderTurnFailure } from '../../src/contracts/index.js';
import { LlmRequestError, type LlmTransportFailure } from '../../src/contracts/llm-failure.js';

const compact = (args: Omit<CompactArgs, 'progress'>): Promise<CompactionResult> => compactWithoutProgress({ ...args, progress: noCompactionProgress });

const SESSION: ConversationSessionId = 'agent:planner:project';
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' };
const BIG = 'x'.repeat(12_000);

type SummaryCall = { sessionId: string; systemPrompt: string; contents: string[] };

function summarizer(args: { calls: SummaryCall[]; summaryOf: (call: SummaryCall) => string }): SummarizerProviderPort {
  return {
    candidate: CANDIDATE,
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    serializeSummaryRequest: deterministicSummarySerialization,
    completeTurn: async (input): Promise<{ result: { kind: 'message'; content: string }; provider_exchanges: never[] }> => {
      const call: SummaryCall = { sessionId: input.sessionId, systemPrompt: input.systemPrompt, contents: input.providerConversation.messages.map((row) => row.content) };
      args.calls.push(call);
      return { result: { kind: 'message' as const, content: args.summaryOf(call) }, provider_exchanges: [] };
    },
    projectProviderExchanges: jest.fn(),
  };
}

const constantSummary = (text: string) => (): string => text;

function invocation(conversation: ValidatedConversation, overrides: Partial<PreparedLlmInvocationInput> = {}): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction(POLICY, 'system', [], 8_000, 2_000);
  return {
    inputId: '00000000-0000-4000-8000-000000000001',
    agentId: SESSION,
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: providerConversationProjection(conversation, []),
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
    episodeContext: {},
    ...overrides,
  };
}

async function compactOnce(root: string, strategy: 'preventive' | 'authoritative_context_recovery' | 'local_exact_admission', provider: SummarizerProviderPort, conversation: ValidatedConversation, publication?: Parameters<typeof compact>[0]['publication']) {
  return compact({ strategy, conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: provider, signal: new AbortController().signal, publication });
}

function activation(ordinal: number, sessionId: ConversationSessionId = SESSION): AgentMessage {
  const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  const timestamp = `2026-08-18T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  return {
    id: `activation-${ordinal}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    context_policy: ACTIVITY_ROW_POLICY,
    content: JSON.stringify(sessionId === SESSION
      ? { event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId, timestamp }
      : { event: 'activation_open', agent_name: 'compaction-summarizer', input_id: inputId, timestamp }),
    round_id: `r-pre-${String(ordinal).padStart(32, '0')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
  } as AgentMessage;
}

function text(id: string, content: string, sessionId: ConversationSessionId = SESSION): AgentMessage {
  return {
    id,
    session_id: sessionId,
    role: 'user',
    kind: 'text',
    context_policy: TEXT_ROW_POLICY,
    content,
    round_id: `r-user-${'2'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: '2026-08-18T00:00:01.000Z',
  } as AgentMessage;
}
function protectedText(id: string, content: string, key?: string): AgentMessage { const message = text(id, content); return { ...message, context_policy: { ...TEXT_ROW_POLICY, compactable: false, ...(key === undefined ? {} : { compaction_key: key }) } } as AgentMessage; }

function settledBundle(inputId: string, callId: string, body: string, sessionId: ConversationSessionId = SESSION): AgentMessage[] {
  const result = JSON.stringify({ success: true, data: { content: body } });
  const policies = toolRowPolicies({ content: result });
  return [
    { id: `${inputId}:tool-call:${callId}`, session_id: sessionId, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: callId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }), context_policy: policies.call, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 2, block_index: 0, timestamp: '2026-08-18T00:00:02.000Z' } as AgentMessage,
    { id: `${inputId}:tool-result:${callId}`, session_id: sessionId, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: callId, content: result, context_policy: policies.result, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 3, block_index: 0, timestamp: '2026-08-18T00:00:03.000Z' } as AgentMessage,
  ];
}

function unmatchedCall(inputId: string, callId: string): AgentMessage {
  const policies = toolRowPolicies({ content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }) });
  return { id: `${inputId}:tool-call:${callId}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: callId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }), context_policy: policies.call, round_id: `r-assistant-${'6'.repeat(32)}`, message_index: 4, block_index: 0, timestamp: '2026-08-18T00:00:07.000Z' } as AgentMessage;
}

describe('compaction fallback, successor identity, and internal summary identity', () => {
  it('rejects prospectively mutated protected rows and extraction coordinates even when their replacement list hash is self-consistent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-protected-derivation-')); initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), protectedText('protected-source', 'EXACT SOURCE INSTRUCTION', 'workflow.rule'), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const source = readConversation(root, SESSION);
      const sourceBytes = readCurrentConversationSegment(root, SESSION)!.bytes;
      const result = await compactOnce(root, 'preventive', summarizer({ calls: [], summaryOf: constantSummary('summary') }), source);
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      if (segment.genesis.kind !== 'compacted_segment_genesis') throw new Error('expected compacted genesis');
      const history = segment.genesis.compaction;
      expect(segment.index.format_version).toBe(3);
      expect(segment.genesis.format_version).toBe(3);
      const envelope = JSON.parse(segment.bytes.toString('utf8'));
      expect(envelope.version).toBe(3);
      expect(segment.genesis.source.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
      expect(history.coverageCommitment.protectedPromptsSha256).toBe(createHash('sha256').update(canonicalJson(history.protectedPrompts)).digest('hex'));
      expect(segment.genesis.retained_rows.sha256).toBe(createHash('sha256').update(canonicalJson(segment.rows)).digest('hex'));
      expect(conversationSegmentEnvelopeSchema.safeParse({ ...envelope, rows: [{ ...segment.genesis, format_version: 2 }, ...segment.rows] }).success).toBe(false);
      expect(readConversation(root, SESSION).effectiveCompactedHistory).toEqual(history);
      expect(history.protectedPrompts).toHaveLength(1);
      const cutoff = source.sourceRows.findIndex(({ id }) => id === history.coverageCommitment.coveredThroughMessageId) + 1;
      const validate = (successor: CompactedHistory) => validateCompactedHistorySuccessor({ source, sourceGenesis: null, sourceVersion: 1, successor, coveredRows: source.sourceRows.slice(0, cutoff) });
      expect(() => validate(history)).not.toThrow();

      const changedMessage = [{ ...history.protectedPrompts[0]!, message: { ...history.protectedPrompts[0]!.message, content: 'MUTATED INSTRUCTION' } }];
      expect(() => validate({ ...history, protectedPrompts: changedMessage, coverageCommitment: { ...history.coverageCommitment, protectedPromptsSha256: canonicalValueSha256(changedMessage) } })).toThrow(/do not exactly derive/);
      const changedCoordinate = [{ ...history.protectedPrompts[0]!, source: { ...history.protectedPrompts[0]!.source, rowIndex: history.protectedPrompts[0]!.source.rowIndex + 1 } }];
      expect(() => validate({ ...history, protectedPrompts: changedCoordinate, coverageCommitment: { ...history.coverageCommitment, protectedPromptsSha256: canonicalValueSha256(changedCoordinate) } })).toThrow(/do not exactly derive/);
      expect(() => validate({ ...history, protectedPrompts: [], coverageCommitment: { ...history.coverageCommitment, protectedPromptsSha256: canonicalValueSha256([]) } })).toThrow(/do not exactly derive/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('advances deterministically across closed rounds and a partial open prefix, never completing the open round', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-fallback-open-'));
    initProjectTree(root);
    try {
      const bundle = settledBundle('00000000-0000-4000-8000-000000000003', 'call-3', 'OPEN-BODY'.concat('-open'.repeat(2000)));
      appendConversationBatch({ projectRoot: root }, [
        activation(1), text('t1', 'small-one'),
        activation(2), text('t2', 'small-two'),
        activation(3), text('t3', 'small-three'), ...bundle, unmatchedCall('00000000-0000-4000-8000-000000000003', 'call-unmatched'),
      ]);
      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'authoritative_context_recovery', summarizer({ calls, summaryOf: constantSummary('covered summary') }), readConversation(root, SESSION));
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('compacted_segment_genesis');
      expect(segment.rows.map((row) => row.id)).toEqual([unmatchedCall('00000000-0000-4000-8000-000000000003', 'call-unmatched').id]);
      expect(segment.genesis.kind === 'compacted_segment_genesis' && segment.genesis.continuation.kind).toBe('inherited_open_round');
      expect(segment.conversation.rounds.at(-1)!.state).toBe('open');
      expect(segment.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe(bundle[1]!.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('local exact admission uses refined packing to reach the furthest qualifying endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-local-exact-smallest-'));
    initProjectTree(root);
    try {
      const LOCAL_BIG = 'x'.repeat(9000);
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', `${LOCAL_BIG}T1-PLAIN`), activation(2), text('t2', `${LOCAL_BIG}T2-EXPLODE`), activation(3), text('t3', `${LOCAL_BIG}T3-PLAIN`)]);
      const calls: SummaryCall[] = [];
      const conversation = readConversation(root, SESSION);
      const localPolicy = { ...POLICY, tail_fraction: 0.25 };
      const preparedCompaction = prepareCompaction(localPolicy, 'system', [], 8_000, 2_000);
      const result = compact({ strategy: 'local_exact_admission', conversations: { projectRoot: root }, input: invocation(conversation, {
        preparedCompaction,
        preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
      }), summarizerProvider: summarizer({
        calls,
        summaryOf: (call) => (call.contents.some((content) => content.includes('T3-PLAIN')) ? '   ' : 'Q'.repeat(200)),
      }), signal: new AbortController().signal });
      await expect(result).resolves.toMatchObject({ kind: 'compacted' });
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(2);
      expect(readCurrentConversationSegment(root, SESSION)!.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe('t2');
      const rawInputs = calls.flatMap((call) => call.contents);
      expect(rawInputs.filter((content) => content.includes('T1-PLAIN'))).toHaveLength(1);
      expect(rawInputs.filter((content) => content.includes('T2-EXPLODE'))).toHaveLength(1);
      expect(rawInputs.filter((content) => content.includes('T3-PLAIN'))).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }

    const rootFurthest = mkdtempSync(join(tmpdir(), 'compaction-local-exact-furthest-'));
    initProjectTree(rootFurthest);
    try {
      const LOCAL_BIG = 'x'.repeat(9000);
      appendConversationBatch({ projectRoot: rootFurthest }, [activation(1), text('t1', `${LOCAL_BIG}T1-PLAIN`), activation(2), text('t2', `${LOCAL_BIG}T2-EXPLODE`), activation(3), text('t3', `${LOCAL_BIG}T3-PLAIN`)]);
      const furthestCalls: SummaryCall[] = [];
      const result = await compactOnce(rootFurthest, 'local_exact_admission', summarizer({ calls: furthestCalls, summaryOf: constantSummary('Q'.repeat(200)) }), readConversation(rootFurthest, SESSION));
      if (result.kind !== 'compacted') throw new Error('expected compacted');
      const segment = readCurrentConversationSegment(rootFurthest, SESSION)!;
      expect(segment.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe('t3');
      expect(segment.rows).toEqual([]);
      expect(furthestCalls.flatMap((call) => call.contents).filter((content) => content.includes('T2-EXPLODE'))).toHaveLength(1);
    } finally { rmSync(rootFurthest, { recursive: true, force: true }); }
  });

  it('uses only the selected endpoints without resubmitting source or publishing when none is accepted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-selected-endpoints-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [
        activation(1), text('t1', 'ROW-ONE'.concat('x'.repeat(3000))),
        activation(2), text('t2', 'ROW-TWO'.concat('x'.repeat(3000))),
        activation(3), text('t3', 'ROW-THREE'.concat('x'.repeat(3000))),
      ]);
      const conversation = readConversation(root, SESSION);
      const restrictivePolicy: AutonomousCompactionPolicy = {
        context_utilization_fraction: 0.8, trigger_fraction: 0.3,
        tail_fraction: 0.1,
        snap: 'compact_straddler',
      };
      const preparedCompaction = prepareCompaction(restrictivePolicy, 'system', [], 8_000, 2_000);
      const input = invocation(conversation, {
        preparedCompaction,
        preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
      });
      const calls: SummaryCall[] = [];
      await expect(compact({
        strategy: 'preventive', conversations: { projectRoot: root }, input,
        summarizerProvider: summarizer({ calls, summaryOf: constantSummary('S'.repeat(11_900)) }), signal: new AbortController().signal,
      })).rejects.toMatchObject({ name: 'CompactionSummaryConstructionError', reason: 'no_reduction', correctionCount: 1 });
      const leafInputs = calls.flatMap((call) => call.contents);
      expect(leafInputs.filter((content) => content.includes('ROW-ONE'))).toHaveLength(1);
      for (const marker of ['ROW-TWO', 'ROW-THREE'])
        expect(leafInputs.filter((content) => content.includes(marker))).toHaveLength(2);
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);

      const exactCalls: SummaryCall[] = [];
      const noSmaller = await compact({
        strategy: 'local_exact_admission', conversations: { projectRoot: root }, input,
        summarizerProvider: summarizer({ calls: exactCalls, summaryOf: constantSummary('S'.repeat(11_900)) }), signal: new AbortController().signal,
      });
      expect(noSmaller.kind).toBe('no_smaller_projection');
      if (noSmaller.kind !== 'no_smaller_projection') throw new Error('expected no-smaller diagnostics');
      expect(noSmaller.smallestCandidateEstimatedProviderMessageTokens).not.toBeNull();
      expect(noSmaller.rejectedEstimatedProviderMessageTokens).toBeLessThan(noSmaller.smallestCandidateEstimatedProviderMessageTokens!);
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['content_policy', true],
    ['input_context_exhausted', true],
    ['output_token_limit_exceeded', true],
    ['server_transient', false],
    ['provider_protocol_error', false],
  ] satisfies Array<['content_policy' | 'input_context_exhausted' | 'output_token_limit_exceeded' | 'server_transient' | 'provider_protocol_error', boolean]>)('retains a complete preferred candidate across eligible %s exhaustion only', async (kind, allowsFallback) => {
    const root = mkdtempSync(join(tmpdir(), `compaction-retained-${kind}-`));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      let calls = 0;
      const failure = summaryProviderFailure(kind);
      const provider: SummarizerProviderPort = {
        candidate: CANDIDATE,
        contextWindowTokens: 100_000,
        maxOutputTokens: 10_000,
        serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async () => {
          calls++;
          if (calls === 1) return { result: { kind: 'message' as const, content: 'R'.repeat(6_000) }, provider_exchanges: [] };
          throw failure;
        },
        projectProviderExchanges: jest.fn(),
      };
      const conversation = readConversation(root, SESSION);
      const policy = { ...POLICY, trigger_fraction: 0.3, tail_fraction: 0.1 };
      const preparedCompaction = prepareCompaction(policy, 'system', [], 8_000, 2_000);
      const preparedContext = buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction });
      const operation = compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation, { preparedCompaction, preparedContext }), summarizerProvider: provider, signal: new AbortController().signal });
      if (allowsFallback) {
        await expect(operation).resolves.toMatchObject({ kind: 'compacted' });
        expect(readConversationCatalog(root, SESSION).versions).toHaveLength(2);
      } else {
        await expect(operation).rejects.toBe(failure);
        expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);
      }
      expect(calls).toBe(kind === 'output_token_limit_exceeded' ? 3 : 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails freshness before summary or publication when the prepared projection is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-freshness-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const stale = invocation(conversation, {
        providerConversation: { sourceSessionId: SESSION, messages: providerConversationProjection(conversation, []).messages.slice(0, 1) },
      });
      const calls: SummaryCall[] = [];
      await expect(compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: stale, summarizerProvider: summarizer({ calls, summaryOf: constantSummary('s') }), signal: new AbortController().signal })).rejects.toThrow(/stale/);
      expect(calls).toHaveLength(0);
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns the exact published successor projection with the preallocated genesis identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-identity-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const publicationTrace: string[] = []; let preparedEnvelope: Buffer | undefined; let selectedPath = '';
      const indexPath = cardConversationVersionIndexFile(root, 'project', 'planner');
      const priorIndex = readFileSync(indexPath); const priorInode = statSync(indexPath).ino;
      const factory = jest.fn(() => `00000000-0000-4000-8000-${String(publicationTrace.length).padStart(12, '0')}`);
      const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root, changes: { conversationChanged() { publicationTrace.push('hint'); }, agentMembershipChanged() { publicationTrace.push('membership'); } } }, input: invocation(readConversation(root, SESSION)), summarizerProvider: summarizer({ calls: [], summaryOf: constantSummary('identity summary') }), signal: new AbortController().signal, publication: {
        temporary: factory,
        io: {
          publishFreshFile: (path, bytes, temporary) => {
            selectedPath = path; preparedEnvelope = bytes; publicationTrace.push('segment-start');
            publishFreshFile(path, bytes, temporary); publicationTrace.push('segment-done');
          },
          publishHeadFile: (path, previous, bytes, mode, temporary) => {
            publicationTrace.push('index-start'); publishHeadFile(path, previous, bytes, mode, temporary); publicationTrace.push('index-done');
          },
        },
      } });
      publicationTrace.push('returned');
      if (result.kind !== 'compacted') throw new Error('expected compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('compacted_segment_genesis');
      const genesis = segment.genesis.kind === 'compacted_segment_genesis' ? segment.genesis : null;
      expect(genesis).not.toBeNull();
      const historyRow = result.providerConversation.messages.find((row) => row.kind === 'synthetic_context' && row.origin === 'history_summary');
      if (!historyRow || historyRow.kind !== 'synthetic_context' || historyRow.origin !== 'history_summary') throw new Error('expected synthetic compacted history');
      expect(historyRow.block_identity).toBe(`${genesis!.id}:compacted-history`);
      expect(publicationTrace).toEqual(['segment-start', 'segment-done', 'index-start', 'index-done', 'hint', 'returned']);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(statSync(conversationPreviousIndexFile(indexPath)).ino).toBe(priorInode);
      expect(readFileSync(conversationPreviousIndexFile(indexPath))).toEqual(priorIndex);
      expect(selectedPath).toBe(join(root, '.saivage', 'cards', 'project', 'conversations', 'planner', 'versions', segment.entry.filename));
      expect(preparedEnvelope).toEqual(segment.bytes);
      expect(JSON.parse(preparedEnvelope!.toString()).rows[0].id).toBe(genesis!.id);
      expect(result.providerConversation).toEqual(providerConversationProjection(segment.conversation, []));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['segment', 'temp-open'], ['segment', 'write'], ['segment', 'file-fsync'], ['segment', 'file-close'],
    ['segment', 'rename'], ['segment', 'rename-effect-throw'], ['segment', 'parent-open'], ['segment', 'parent-fsync'], ['segment', 'parent-close'],
    ['index', 'temp-open'], ['index', 'rename'], ['index', 'parent-fsync'],
  ] satisfies Array<['segment' | 'index', PublicationFault]>)('stops compactor at actual %s %s publication failure, preserving its identity', async (owner, phase) => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-publication-')); initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const source = readConversation(root, SESSION);
      const witness = publicationWitness(phase); const effects: string[] = []; const calls: SummaryCall[] = [];
      let classified: unknown; let segmentAttempts = 0; let indexAttempts = 0; const allocated: string[] = [];
      const temporary = () => { const id = `00000000-0000-4000-8000-${String(allocated.length + 1).padStart(12, '0')}`; allocated.push(id); return id; };
      const preserve = (publish: () => void) => { try { publish(); } catch (error) { classified = error; throw error; } };
      let thrown: unknown;
      try {
        await compact({ strategy: 'preventive', conversations: { projectRoot: root, changes: { conversationChanged() { effects.push('hint'); }, agentMembershipChanged() { effects.push('membership'); } } }, input: invocation(source), summarizerProvider: summarizer({ calls, summaryOf: constantSummary('s') }), signal: new AbortController().signal, publication: {
          temporary,
          io: {
            publishFreshFile: (path, bytes, factory) => {
              segmentAttempts++; effects.push('segment');
              preserve(() => publishFreshFile(path, bytes, factory, owner === 'segment' ? witness.io : undefined));
            },
            publishHeadFile: (path, previous, bytes, mode, factory) => {
              indexAttempts++; effects.push('index');
              preserve(() => publishHeadFile(path, previous, bytes, mode, factory, witness.io));
            },
          },
        } });
      } catch (error) { thrown = error; }
      const fatal = ['rename', 'rename-effect-throw', 'parent-open', 'parent-fsync', 'parent-close'].includes(phase);
      if (fatal) { expect(thrown).toBe(classified); expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError); expect((thrown as Error).cause).toBe(witness.failure); }
      else { expect(classified).toBe(witness.failure); expect(thrown).toMatchObject({ name: 'CompactionAppendError', cause: witness.failure }); }
      expect(segmentAttempts).toBe(1); expect(indexAttempts).toBe(owner === 'index' ? 1 : 0);
      expect(effects).toEqual(owner === 'index' ? ['segment', 'index'] : ['segment']);
      expect(allocated).toHaveLength(owner === 'index' && phase !== 'parent-fsync' ? 2 : 1);
      expect(witness.trace.at(-1)).toBe(phase === 'rename-effect-throw' ? 'rename' : phase);
      expect(calls).toHaveLength(1); // No fallback/summary work after failed publication.
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('publishes summary evidence under the internal namespace even beside a legal configured compaction-summarizer agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-internal-identity-'));
    initProjectTree(root);
    try {
      const agentSession = globalAgentSessionId('compaction-summarizer');
      initializeConversation(root, agentSession);
      appendConversationBatch({ projectRoot: root }, [activation(1, agentSession), text('t1', BIG, agentSession), activation(2, agentSession), text('t2', BIG, agentSession), activation(3, agentSession), text('t3', BIG, agentSession)]);
      const conversation = readConversation(root, agentSession);
      const preparedCompaction = prepareCompaction(POLICY, 'system', [], 8_000, 2_000);
      const input: PreparedLlmInvocationInput = {
        ...invocation(conversation),
        sessionId: agentSession,
        agentId: agentSession,
        agentName: 'compaction-summarizer',
        preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
      };
      const calls: SummaryCall[] = [];
      const projectedSessions: string[] = [];
      const provider = summarizer({ calls, summaryOf: constantSummary('internal summary') });
      const result = await compact({
        strategy: 'preventive',
        conversations: { projectRoot: root },
        input,
        summarizerProvider: { ...provider, projectProviderExchanges: (sessionId) => { projectedSessions.push(sessionId); } },
        signal: new AbortController().signal,
      });
      if (result.kind !== 'compacted') throw new Error('expected compacted');
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((call) => call.sessionId))).toEqual(new Set([internalCompactionSummarySessionId(agentSession)]));
      expect(ConversationSessionIdSchema.safeParse(internalCompactionSummarySessionId(agentSession)).success).toBe(false);
      expect(internalCompactionSummarySessionId(agentSession)).not.toBe(agentSession);
      expect(projectedSessions).toEqual([agentSession]);
      expect(readConversationCatalog(root, agentSession).versions).toHaveLength(2);
      expect(readCurrentConversationSegment(root, agentSession)!.rows.every((row) => row.session_id === agentSession)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('materializes a large uncovered body within the refine ceiling into admitted compacted bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-local-exact-large-'));
    initProjectTree(root);
    try {
      const body = 'MCP-SHAPED-'.repeat(20_000);
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), ...settledBundle('00000000-0000-4000-8000-000000000001', 'call-1', body), activation(2), text('t2', 'small')]);
      const conversation = readConversation(root, SESSION);
      expect(providerConversationProjection(conversation, []).messages.some((row) => row.content.includes('MCP-SHAPED-'))).toBe(true);
      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'local_exact_admission', summarizer({ calls, summaryOf: (call) => `seg:${call.contents.length}` }), conversation);
      if (result.kind !== 'compacted') throw new Error('expected compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.rows.some((row) => row.content.includes('MCP-SHAPED-'))).toBe(false);
      expect(result.providerConversation.messages.some((row) => row.content.includes('MCP-SHAPED-'))).toBe(false);
      expect(segment.conversation.effectiveCompactedHistory!.summaryText.length).toBeGreaterThan(0);
      const serialized: SummaryRequestSerialization = deterministicSummarySerialization({
        systemPrompt: 'probe',
        providerConversation: { sourceSessionId: SESSION, messages: result.providerConversation.messages },
      } as never);
      expect(serialized.estimatedInputTokens).toBeLessThan(
        deterministicSummarySerialization({ systemPrompt: 'probe', providerConversation: { sourceSessionId: SESSION, messages: providerConversationProjection(conversation, []).messages } } as never).estimatedInputTokens,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function summaryProviderFailure(kind: 'content_policy' | 'input_context_exhausted' | 'output_token_limit_exceeded' | 'server_transient' | 'provider_protocol_error'): ProviderTurnFailure {
  const common = { provider: 'test', message: 'SENTINEL PROVIDER DETAIL', status: kind === 'server_transient' ? 503 : 400 };
  let failure: LlmTransportFailure;
  if (kind === 'content_policy') failure = { kind, provider: common.provider, message: common.message, status: common.status, providerResponse: 'SENTINEL RAW RESPONSE' };
  else failure = { kind, ...common };
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [], originalFailure: new LlmRequestError(failure), candidate: CANDIDATE });
}
