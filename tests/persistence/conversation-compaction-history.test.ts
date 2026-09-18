import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, readConversation, readConversationCatalog, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { foldConversation } from '../../src/application/read-models/agent-conversation-read-model.js';
import { CompactionSummaryConstructionError, compact as compactWithoutProgress, prepareCompaction, shouldCompact, type AutonomousCompactionPolicy, type CompactArgs, type CompactionResult } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { composeContextProjection, providerConversationFromComposedContext, type ComposedContextProjection } from '../../src/runtime/actors/context/composition-projector.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import { canonicalValueSha256 } from '../../src/persistence/canonical-conversation-artifacts.js';
import {
  contentPolicyRefusalProjectionText,
  MODEL_RECOVERY_NOTICE_TEXT,
  STRUCTURAL_ROW_POLICY,
  type AgentMessage,
} from '../../src/schemas/index.js';
import type { ValidatedConversation } from '../../src/contracts/conversation-validation.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { EMPTY_COVERAGE_SUMMARY, SUMMARY_REFINE_INSTRUCTION, SummaryConstructionLimitError } from '../../src/runtime/actors/compaction/refine-accumulator.js';
import { SummaryResultValidationError, type SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { classifyConversationRounds, estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import { deterministicRoundId } from '../../src/schemas/round-id-server.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';

const compact = (args: Omit<CompactArgs, 'progress'>): Promise<CompactionResult> => compactWithoutProgress({ ...args, progress: noCompactionProgress });

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' };
const BIG = 'x'.repeat(12_000);

type SummaryCall = { systemPrompt: string; contents: string[]; result: string };
type ParsedSummaryContent = Readonly<{ label: string; body: string }>;

function parseSummaryContents(call: SummaryCall): ParsedSummaryContent[] {
  return call.contents.map((content, index) => {
    const match = /^\[order (\d+)\/(\d+)\] ([^\n]+)\n([\s\S]*)$/u.exec(content);
    if (!match) throw new Error(`summary content ${index + 1} has an invalid wrapper`);
    expect(Number(match[1])).toBe(index + 1);
    expect(Number(match[2])).toBe(call.contents.length);
    return { label: match[3]!, body: match[4]! };
  });
}

function recordingSummarizer(calls: SummaryCall[]) {
  return {
    candidate: CANDIDATE,
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    serializeSummaryRequest: deterministicSummarySerialization,
    completeTurn: async (input: Parameters<SummarizerProviderPort['completeTurn']>[0]) => {
      const previews = input.providerConversation.messages.map((row) => row.content.split('\n').slice(1).join('\n').slice(0, 120)).join('|');
      const markers = [...new Set(input.providerConversation.messages.flatMap((row) => row.content.match(/OPERATIONAL-FINDINGS|BUNDLE-(?:TWO|FIVE)/g) ?? []))];
      const result = input.systemPrompt === SUMMARY_REFINE_INSTRUCTION
        ? `merge[${markers.join('|') || previews.slice(0, 40)}]`
        : `round[${markers.join('|') || previews.slice(0, 40)}]`;
      calls.push({ systemPrompt: input.systemPrompt, contents: input.providerConversation.messages.map((row) => row.content), result });
      return { result: { kind: 'message' as const, content: result }, provider_exchanges: [] };
    },
    projectProviderExchanges: jest.fn(),
  };
}

function refineCalls(calls: readonly SummaryCall[]): SummaryCall[] {
  return calls.filter((call) => call.systemPrompt === SUMMARY_REFINE_INSTRUCTION);
}

function invocation(conversation: ValidatedConversation): PreparedLlmInvocationInput {
  const providerConversation = providerConversationProjection(conversation, []);
  const preparedCompaction = prepareCompaction(POLICY, 'system', [], 8_000, 2_000);
  return {
    inputId: '00000000-0000-4000-8000-000000000001',
    agentId: SESSION,
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation,
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
    episodeContext: {},
  };
}

function composedOf(conversation: ValidatedConversation): ComposedContextProjection {
  const genesis = conversation.compactedGenesis;
  const history = conversation.effectiveCompactedHistory;
  return composeContextProjection({
    sourceSessionId: conversation.sourceSessionId,
    effectiveHistory: genesis && history
      ? { summaryText: history.summaryText, historyMessageId: `${genesis.id}:compacted-history`, historyTimestamp: genesis.timestamp, requiredModelFacts: history.requiredModelFacts, protectedPrompts: history.protectedPrompts }
      : null,
    dynamicBlocks: [],
    uncoveredRows: conversation.sourceRows,
  });
}

function activation(ordinal: number): AgentMessage {
  const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  const timestamp = `2026-08-18T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  return {
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
  } as AgentMessage;
}

function text(id: string, content: string, audience: 'primary_and_summarizer' | 'summarizer_only' | 'evidence_only' = 'primary_and_summarizer'): AgentMessage {
  return {
    id,
    session_id: SESSION,
    role: 'user',
    kind: 'text',
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience, evidence: { kind: 'none' }, compactable: true },
    content,
    round_id: `r-user-${'2'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: '2026-08-18T00:00:01.000Z',
  } as AgentMessage;
}

function protectedText(id:string,content:string,key?:string):AgentMessage{
  const message=text(id,content);
  return {...message,context_policy:{...message.context_policy,compactable:false,...(key===undefined?{}:{compaction_key:key})}} as AgentMessage;
}

function summarizerOnlyBundle(inputId: string, callId: string, body: string): AgentMessage[] {
  const result = JSON.stringify({ success: true, data: { content: body } });
  const policies = toolRowPolicies({ content: result, template: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, evidence: { kind: 'observational_query', observedSha256: createHash('sha256').update(result, 'utf8').digest('hex') } });
  return [
    { id: `${inputId}:tool-call:${callId}`, session_id: SESSION, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: callId, content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }), context_policy: policies.call, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 2, block_index: 0, timestamp: '2026-08-18T00:00:02.000Z' } as AgentMessage,
    { id: `${inputId}:tool-result:${callId}`, session_id: SESSION, role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: callId, content: result, context_policy: policies.result, round_id: `r-assistant-${'3'.repeat(32)}`, message_index: 3, block_index: 0, timestamp: '2026-08-18T00:00:03.000Z' } as AgentMessage,
  ];
}

function recoveryNotice(ordinal: number): AgentMessage {
  const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  return {
    id: `${inputId}:model-recovered`,
    session_id: SESSION,
    role: 'system',
    kind: 'model_recovered',
    context_policy: STRUCTURAL_ROW_POLICY.model_recovery_notice,
    content: MODEL_RECOVERY_NOTICE_TEXT,
    round_id: `r-pre-${'4'.repeat(32)}`,
    message_index: 0,
    block_index: 1,
    timestamp: '2026-08-18T00:00:04.000Z',
  } as AgentMessage;
}

function refusalMarker(ordinal: number): AgentMessage {
  const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  const message = buildContentPolicyRefusalMessage({ sessionId: SESSION, sourceInputId: inputId, candidate: { provider: 'test', account: null, model: 'test' }, providerResponse: `RAW-REFUSAL-${ordinal}` });
  return { ...message, timestamp: '2026-08-18T00:00:05.000Z' } as AgentMessage;
}

async function compactOnce(root: string, strategy: 'preventive' | 'authoritative_context_recovery' | 'local_exact_admission', calls: SummaryCall[]) {
  const conversation = readConversation(root, SESSION);
  return compact({ strategy, conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: recordingSummarizer(calls), signal: new AbortController().signal });
}

describe('accumulated compaction history generations', () => {
  it('extracts protected instructions, orients without summarizing them, and folds a released keyed instruction once',async()=>{
    const root=mkdtempSync(join(tmpdir(),'compaction-history-protected-'));initProjectTree(root);
    try{
      const oldInstruction='EXACT-KEYED-INSTRUCTION-OLD';
      appendConversationBatch({projectRoot:root},[activation(1),text('q1',BIG),protectedText('instruction-old',oldInstruction,'workflow.rule'),activation(2),text('q2',BIG),activation(3),text('q3',BIG)]);
      const firstCalls:SummaryCall[]=[];
      expect((await compactOnce(root,'preventive',firstCalls)).kind).toBe('compacted');
      const first=readCurrentConversationSegment(root,SESSION)!;
      const firstHistory=first.conversation.effectiveCompactedHistory!;
      expect(firstHistory.protectedPrompts.map(({message})=>message.id)).toEqual(['instruction-old']);
      expect(firstHistory.dispositionCommitment.protected).toBe(1);
      expect(first.rows.some(({id})=>id==='instruction-old')).toBe(false);
      const firstItems=firstCalls.flatMap(parseSummaryContents);
      expect(firstItems.filter(({label,body})=>label.includes('kind=protected_instruction')&&body===oldInstruction)).toHaveLength(firstCalls.length);
      expect(firstItems.some(({label,body})=>!label.includes('kind=protected_instruction')&&body===oldInstruction)).toBe(false);
      expect(providerConversationProjection(first.conversation,[]).messages.filter(({content})=>content===oldInstruction)).toHaveLength(1);

      const newInstruction='EXACT-KEYED-INSTRUCTION-NEW';
      appendConversationBatch({projectRoot:root},[activation(4),text('q4',BIG),protectedText('instruction-new',newInstruction,'workflow.rule'),activation(5),text('q5',BIG),activation(6),text('q6',BIG)]);
      const secondCalls:SummaryCall[]=[];
      expect((await compactOnce(root,'preventive',secondCalls)).kind).toBe('compacted');
      const second=readCurrentConversationSegment(root,SESSION)!;
      expect(second.conversation.effectiveCompactedHistory!.protectedPrompts.map(({message})=>message.id)).not.toContain('instruction-old');
      expect([...second.conversation.effectiveCompactedHistory!.protectedPrompts.map(({message})=>message.id),...second.rows.map(({id})=>id)]).toContain('instruction-new');
      const secondItems=secondCalls.flatMap(parseSummaryContents);
      expect(secondItems.filter(({label,body})=>label.includes('kind=released_protected_instruction')&&body===oldInstruction)).toHaveLength(1);
      expect(secondItems.some(({label,body})=>label.includes('kind=protected_instruction')&&body===newInstruction)).toBe(true);
      expect(secondItems.some(({label,body})=>label.includes('kind=released_protected_instruction')&&body===newInstruction)).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  it('publishes and rereads a tail-only successor with explicit policies, two nullable slots, and coverage commitments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-format-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'preventive', calls);
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('compacted_segment_genesis');
      if (segment.genesis.kind !== 'compacted_segment_genesis') throw new Error('unreachable');
      const history = segment.genesis.compaction;
      expect(history.source.kind).toBe('current_rows');
      expect(history.requiredModelFacts).toEqual({ latestRecovery: null, latestContentPolicyRefusal: null });
      expect(history.dispositionCommitment.count).toBe(history.dispositionCommitment.summarized + history.dispositionCommitment.evidenceOnly + history.dispositionCommitment.superseded);
      expect(history.dispositionCommitment.count).toBeGreaterThan(0);
      expect(history.coverageCommitment.coveredThroughMessageId).toBe('t2');
      expect(segment.rows.map((row) => row.id)).toEqual(['activation-3', 't3']);
      expect(segment.conversation.effectiveCompactedHistory).toEqual(history);
      expect(segment.conversation.effectiveValidatedCoverage).toEqual(history.coverageCommitment);
      expect(history.source.groups.every((group) => group.message_ids.length >= 1 && group.content_sha256.length === 64)).toBe(true);
      const tail = segment.conversation.sourceRows.map((row) => row.id);
      expect(tail).toEqual(['activation-3', 't3']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a closed below-trigger summarizer_only bundle primary-visible until coverage, then omits its body only through the accumulated summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-visibility-'));
    initProjectTree(root);
    try {
      const bundleBody = 'OPERATIONAL-FINDINGS'.concat('-detail'.repeat(120));
      appendConversationBatch({ projectRoot: root }, [activation(1), ...summarizerOnlyBundle('00000000-0000-4000-8000-000000000001', 'call-1', bundleBody)]);
      appendConversationBatch({ projectRoot: root }, [activation(2), text('t2', 'small')]);
      const closedConversation = readConversation(root, SESSION);
      expect(shouldCompact(invocation(closedConversation))).toBe(false);
      const beforeClose = providerConversationProjection(closedConversation, []).messages;
      expect(beforeClose.some((row) => row.content.includes(bundleBody))).toBe(true);
      const afterLaterInvocation = providerConversationProjection(readConversation(root, SESSION), []).messages;
      expect(afterLaterInvocation.some((row) => row.content.includes(bundleBody))).toBe(true);
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);

      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'preventive', calls);
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.rows.some((row) => row.content.includes(bundleBody))).toBe(false);
      const projected = providerConversationProjection(segment.conversation, []).messages;
      expect(projected.some((row) => row.content.includes(bundleBody))).toBe(false);
      expect(segment.conversation.effectiveCompactedHistory!.summaryText.includes('OPERATIONAL-FINDINGS')).toBe(true);
      expect(projected.some((row) => row.content === `Historical summary:\n${segment.conversation.effectiveCompactedHistory!.summaryText}`)).toBe(true);
      expect(calls.some((call) => call.contents.some((content) => content.includes('OPERATIONAL-FINDINGS')))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('creates no coverage, publication, or omission when the summary attempt fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-failure-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const failure = new ProviderTurnFailure({
        failure_phase: 'provider_attempt', provider_exchanges: [], candidate: CANDIDATE,
        originalFailure: new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 503, message: 'summary provider failed' }),
      });
      const failing = {
        candidate: CANDIDATE,
        contextWindowTokens: 100_000,
        maxOutputTokens: 10_000,
        serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async () => { throw failure; },
        projectProviderExchanges: jest.fn(),
      };
      await expect(compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: failing, signal: new AbortController().signal })).rejects.toBe(failure);
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('ordinary_segment_genesis');
      expect(segment.rows).toHaveLength(6);
      expect(providerConversationProjection(segment.conversation, []).messages.some((row) => row.content === BIG)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['tool-call result', { kind: 'tool_calls' as const, tool_calls: [] }],
    ['empty text', { kind: 'message' as const, content: '   ' }],
  ])('corrects malformed successful %s once and wraps repeated noncompliance without publication', async (_label, malformedResult) => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-malformed-summary-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const completeTurn = jest.fn(async () => ({ result: malformedResult, provider_exchanges: [] }));
      const operation = compact({
        strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation),
        summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn, projectProviderExchanges: jest.fn() },
        signal: new AbortController().signal,
      });
      const failure = await operation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CompactionSummaryConstructionError);
      expect((failure as Error & { cause: unknown }).cause).toBeInstanceOf(SummaryResultValidationError);
      expect(completeTurn).toHaveBeenCalledTimes(2);
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves abort and summary-exchange publication failure identity at the compactor boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-boundary-identity-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const controller = new AbortController();
      const abortReason = new Error('stop compaction summary');
      controller.abort(abortReason);
      const neverCalled = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      await expect(compact({
        strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation),
        summarizerProvider: { candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: neverCalled, projectProviderExchanges: jest.fn() }, signal: controller.signal,
      })).rejects.toBe(abortReason);
      expect(neverCalled).not.toHaveBeenCalled();

      const publicationFailure = new Error('summary exchange publication failed');
      await expect(compact({
        strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation),
        summarizerProvider: {
          candidate: CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization,
          completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }),
          projectProviderExchanges: () => { throw publicationFailure; },
        }, signal: new AbortController().signal,
      })).rejects.toBe(publicationFailure);
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('wraps accumulator capacity failure as summary construction failure without publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-materializer-invariant-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      const operation = compact({
        strategy: 'local_exact_admission', conversations: { projectRoot: root }, input: invocation(conversation),
        summarizerProvider: {
          candidate: CANDIDATE,
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
          serializeSummaryRequest: () => ({ serializedRequest: 'oversized-summary-request', requestSha256: createHash('sha256').update('oversized-summary-request').digest('hex'), estimatedInputTokens: 100_000 }),
          completeTurn,
          projectProviderExchanges: jest.fn(),
        }, signal: new AbortController().signal,
      });
      const failure = await operation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CompactionSummaryConstructionError);
      expect((failure as Error & { cause: unknown }).cause).toBeInstanceOf(SummaryConstructionLimitError);
      expect((failure as Error & { cause: SummaryConstructionLimitError }).cause).toMatchObject({ reason: 'request_context_capacity', invocationCount: 0 });
      expect(completeTurn).not.toHaveBeenCalled();
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('carries accumulated history, unchanged slots, and folded bundles across three successive compactions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-generations-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), recoveryNotice(1)]);
      appendConversationBatch({ projectRoot: root }, [activation(2), ...summarizerOnlyBundle('00000000-0000-4000-8000-000000000002', 'call-2', 'BUNDLE-TWO'.concat('-two'.repeat(4000))), refusalMarker(2)]);
      appendConversationBatch({ projectRoot: root }, [activation(3), text('t3', BIG)]);

      const generationCalls: SummaryCall[][] = [];
      generationCalls.push([]);
      const first = await compactOnce(root, 'preventive', generationCalls[0]!);
      expect(first.kind).toBe('compacted');
      const gen1 = readCurrentConversationSegment(root, SESSION)!;
      const history1 = gen1.conversation.effectiveCompactedHistory!;
      expect(history1.source.kind).toBe('current_rows');
      expect(history1.requiredModelFacts.latestRecovery).toEqual({ sourceMessageId: '00000000-0000-4000-8000-000000000001:model-recovered', activationInputId: '00000000-0000-4000-8000-000000000001' });
      expect(history1.requiredModelFacts.latestContentPolicyRefusal?.activationInputId).toBe('00000000-0000-4000-8000-000000000002');
      const refusal2 = history1.requiredModelFacts.latestContentPolicyRefusal!.markerId;
      expect(gen1.rows.map((row) => row.id)).toEqual(['activation-3', 't3']);
      expect(gen1.conversation.effectiveRequiredModelFacts).toEqual(history1.requiredModelFacts);
      const primary1 = providerConversationProjection(gen1.conversation, []).messages;
      expect(primary1.filter((row) => row.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(primary1.filter((row) => row.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      const summarizer1 = composedOf(gen1.conversation).summarizer;
      expect(summarizer1.filter((item) => item.kind === 'message' && item.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(summarizer1.filter((item) => item.kind === 'message' && item.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      expect(summarizer1[0]).toMatchObject({ kind: 'inherited_summary', content: history1.summaryText });
      expect(JSON.stringify(summarizer1)).not.toContain('RAW-REFUSAL');

      const bundleFiveBody = 'BUNDLE-FIVE'.concat('-five'.repeat(4000));
      appendConversationBatch({ projectRoot: root }, [activation(4), text('t4', BIG), text('eo-4', 'EVIDENCE-ROW-FOUR', 'evidence_only'), activation(5), ...summarizerOnlyBundle('00000000-0000-4000-8000-000000000005', 'call-5', bundleFiveBody), activation(6), text('t6', BIG)]);
      const preSecond = providerConversationProjection(readConversation(root, SESSION), []).messages;
      expect(preSecond.some((row) => row.content.includes(bundleFiveBody))).toBe(true);

      generationCalls.push([]);
      const second = await compactOnce(root, 'preventive', generationCalls[1]!);
      expect(second.kind).toBe('compacted');
      const gen2 = readCurrentConversationSegment(root, SESSION)!;
      const history2 = gen2.conversation.effectiveCompactedHistory!;
      if (history2.source.kind !== 'prior_genesis_plus_current_rows') throw new Error('second generation must name its prior genesis');
      expect(history2.source.priorGenesisId).toBe((gen1.genesis as { id: string }).id);
      expect(history2.source.priorHistoryHash.length).toBe(64);
      expect(history2.requiredModelFacts).toEqual(history1.requiredModelFacts);
      expect(history2.dispositionCommitment.evidenceOnly).toBeGreaterThanOrEqual(1);
      expect(history2.dispositionCommitment.count).toBeGreaterThan(history1.dispositionCommitment.count);
      const mergeInputs2 = refineCalls(generationCalls[1]!);
      expect(mergeInputs2.length).toBeGreaterThan(0);
      expect(mergeInputs2.some((call) => call.contents.some((content) => content.includes(history1.summaryText)))).toBe(true);
      expect(mergeInputs2.some((call) => call.contents.some((content) => content.includes('superseded_')))).toBe(false);
      expect(gen2.rows.map((row) => row.id)).toEqual(['activation-6', 't6']);
      const projected2 = providerConversationProjection(gen2.conversation, []).messages;
      expect(projected2.some((row) => row.content.includes(bundleFiveBody))).toBe(false);
      expect(projected2.filter((row) => row.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(history2.summaryText.includes('BUNDLE-FIVE')).toBe(true);

      appendConversationBatch({ projectRoot: root }, [activation(7), text('t7', BIG), activation(8), text('t8', BIG)]);
      generationCalls.push([]);
      const third = await compactOnce(root, 'preventive', generationCalls[2]!);
      expect(third.kind).toBe('compacted');
      const gen3 = readCurrentConversationSegment(root, SESSION)!;
      const history3 = gen3.conversation.effectiveCompactedHistory!;
      expect(history3.requiredModelFacts).toEqual(history1.requiredModelFacts);
      const mergeInputs3 = refineCalls(generationCalls[2]!);
      expect(mergeInputs3.some((call) => call.contents.some((content) => content.includes(history2.summaryText)))).toBe(true);
      expect(mergeInputs3.some((call) => call.contents.some((content) => content.includes('superseded_')))).toBe(false);
      const projected3 = providerConversationProjection(gen3.conversation, []).messages;
      expect(projected3.some((row) => row.content.includes(bundleFiveBody))).toBe(false);
      expect(projected3.filter((row) => row.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(projected3.filter((row) => row.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      const reread = readConversation(root, SESSION);
      expect(reread.effectiveRequiredModelFacts).toEqual(history1.requiredModelFacts);
      const summarizer3 = composedOf(reread).summarizer;
      expect(summarizer3.filter((item) => item.kind === 'message' && item.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(summarizer3.filter((item) => item.kind === 'message' && item.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1, 2, 3, 4]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('supersedes a refusal slot through a newer covered marker, admits the prior meaning into prose, and keeps only the newest operator locator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-refusal-supersession-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), refusalMarker(1)]);
      const calls1: SummaryCall[] = [];
      expect((await compactOnce(root, 'preventive', calls1)).kind).toBe('compacted');
      const gen1 = readCurrentConversationSegment(root, SESSION)!;
      const marker1 = gen1.conversation.effectiveRequiredModelFacts.latestContentPolicyRefusal!.markerId;

      appendConversationBatch({ projectRoot: root }, [activation(2), text('t2', BIG), refusalMarker(2), activation(3), text('t3', BIG)]);
      const calls2: SummaryCall[] = [];
      expect((await compactOnce(root, 'preventive', calls2)).kind).toBe('compacted');
      const gen2 = readCurrentConversationSegment(root, SESSION)!;
      const facts2 = gen2.conversation.effectiveRequiredModelFacts;
      const marker2 = facts2.latestContentPolicyRefusal!.markerId;
      expect(marker2).not.toBe(marker1);
      expect(facts2.latestRecovery).toBeNull();
      const mergeInputs2 = refineCalls(calls2);
      const supersededRefusalBody = `An earlier activation 00000000-0000-4000-8000-000000000001 ended after repeated provider content-policy refusal; its replanning notice read exactly: ${contentPolicyRefusalProjectionText(SESSION, marker1)}`;
      const supersededRefusalBytes = Buffer.byteLength(supersededRefusalBody, 'utf8');
      const supersededRefusalLabel = `[kind=new_source source=${marker1} source_kind=superseded_refusal_notice range=0:${supersededRefusalBytes} total_bytes=${supersededRefusalBytes} source_sha256=${createHash('sha256').update(supersededRefusalBody, 'utf8').digest('hex')} omitted_source_bytes=0]`;
      const supersededRefusalInputs = mergeInputs2
        .flatMap(parseSummaryContents)
        .filter(({ label }) => label === supersededRefusalLabel);
      expect(supersededRefusalInputs).toHaveLength(1);
      expect(supersededRefusalInputs[0]!.body).toBe(supersededRefusalBody);
      expect(mergeInputs2.flatMap(parseSummaryContents).reduce(
        (count, { body }) => count + body.split(supersededRefusalBody).length - 1,
        0,
      )).toBe(1);
      const projected = providerConversationProjection(gen2.conversation, []).messages;
      expect(projected.filter((row) => row.content === contentPolicyRefusalProjectionText(SESSION, marker2))).toHaveLength(1);
      expect(projected.some((row) => row.content === contentPolicyRefusalProjectionText(SESSION, marker1))).toBe(false);

      const folded = foldConversation(root, SESSION);
      const synthetic = folded.entries.filter((entry) => entry.id === marker2);
      expect(synthetic).toHaveLength(1);
      expect(synthetic[0]!.kind).toBe('text');
      expect(synthetic[0]!.content).toBe(contentPolicyRefusalProjectionText(SESSION, marker2));
      expect(folded.entries.some((entry) => entry.id === marker1)).toBe(false);
      expect(JSON.stringify(folded.entries)).not.toContain('RAW-REFUSAL');

      const marker4 = refusalMarker(4);
      appendConversationBatch({ projectRoot: root }, [activation(4), marker4]);
      const uncovered = foldConversation(root, SESSION);
      const rawMarker = uncovered.entries.find((entry) => entry.id === marker4.id);
      expect(rawMarker?.kind).toBe('content_policy_refusal');
      expect(JSON.parse(rawMarker!.content as string)).toMatchObject({ type: 'content_policy_refusal', source_input_id: '00000000-0000-4000-8000-000000000004' });
      expect(uncovered.entries.some((entry) => entry.id === marker2)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('publishes inherited_open_round with an empty physical tail and validates a later repair continuation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-open-round-'));
    initProjectTree(root);
    try {
      const openRoundBody = 'OPEN-ROUND-BODY'.concat('-open'.repeat(200));
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), ...summarizerOnlyBundle('00000000-0000-4000-8000-000000000001', 'call-1', openRoundBody)]);
      const conversation = readConversation(root, SESSION);
      const result = await compact({ strategy: 'authoritative_context_recovery', conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: recordingSummarizer([]), signal: new AbortController().signal });
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      if (segment.genesis.kind !== 'compacted_segment_genesis') throw new Error('unreachable');
      expect(segment.rows).toEqual([]);
      expect(segment.genesis.continuation.kind).toBe('inherited_open_round');
      expect(segment.genesis.retained_rows.row_count).toBe(0);
      expect(segment.genesis.retained_rows.first_message_id).toBeNull();
      expect(segment.conversation.rounds[0]).toMatchObject({ state: 'open', activation: { source: 'compacted_genesis' } });
      expect(segment.conversation.effectiveValidatedCoverage).not.toBeNull();
      const projected = providerConversationProjection(segment.conversation, []).messages;
      expect(projected.some((row) => row.content.includes(openRoundBody))).toBe(false);
      expect(projected.some((row) => row.content === `Historical summary:\n${segment.conversation.effectiveCompactedHistory!.summaryText}`)).toBe(true);

      const repair: AgentMessage = {
        id: '00000000-0000-4000-8000-000000000009:model-repair',
        session_id: SESSION,
        role: 'user',
        kind: 'model_repair',
        context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
        content: 'repair directive after inherited open round',
        round_id: `r-user-${'5'.repeat(32)}`,
        message_index: 2,
        block_index: 0,
        timestamp: '2026-08-18T00:00:06.000Z',
      } as AgentMessage;
      appendConversationBatch({ projectRoot: root }, [repair]);
      const continued = readCurrentConversationSegment(root, SESSION)!;
      expect(continued.conversation.rounds[0]!.segments.map((segmentOfRound) => segmentOfRound.kind)).toEqual(['initial', 'repair']);
      const continuedProjection = providerConversationProjection(continued.conversation, []).messages;
      expect(continuedProjection.some((row) => row.content === 'repair directive after inherited open round')).toBe(true);
      expect(continuedProjection.some((row) => row.content === `Historical summary:\n${continued.conversation.effectiveCompactedHistory!.summaryText}`)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('continues preventive repeat compaction past an inherited llm_turn_started-only first candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-repeat-'));
    initProjectTree(root);
    try {
      const inheritedInputId = '00000000-0000-4000-8000-000000000001';
      appendConversationBatch({ projectRoot: root }, [
        activation(1),
        text('repeat-predecessor-text', BIG),
        ...summarizerOnlyBundle(inheritedInputId, 'repeat-predecessor-call', 'REPEAT-PREDECESSOR'.concat('-history'.repeat(200))),
      ]);
      const predecessorCalls: SummaryCall[] = [];
      const predecessorResult = await compactOnce(root, 'authoritative_context_recovery', predecessorCalls);
      expect(predecessorResult.kind).toBe('compacted');
      expect(predecessorCalls.length).toBeGreaterThan(0);

      const predecessor = readCurrentConversationSegment(root, SESSION)!;
      const predecessorGenesis = predecessor.genesis;
      if (predecessorGenesis.kind !== 'compacted_segment_genesis') throw new Error('repeat fixture predecessor must be compacted');
      expect(predecessorGenesis.continuation).toEqual({
        kind: 'inherited_open_round',
        activation: { marker_id: 'activation-1', input_id: inheritedInputId },
        active_segment_kind: 'initial',
      });
      expect(predecessor.rows).toEqual([]);
      expect(predecessorGenesis.retained_rows).toMatchObject({
        row_count: 0,
        first_message_id: null,
        last_message_id: null,
      });
      const inheritedSummary = predecessor.conversation.effectiveCompactedHistory!.summaryText;
      expect(inheritedSummary).not.toBe('');
      expect(inheritedSummary).not.toBe(EMPTY_COVERAGE_SUMMARY);
      const predecessorCatalog = readConversationCatalog(root, SESSION);
      const repeatCalls: SummaryCall[] = [];
      expect(repeatCalls).toEqual([]);

      const started: AgentMessage = {
        id: `${inheritedInputId}:started`,
        session_id: SESSION,
        role: 'system',
        kind: 'activity',
        context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
        content: JSON.stringify({ event: 'llm_turn_started', inputId: inheritedInputId, agent_name: 'planner' }),
        round_id: deterministicRoundId('pre', inheritedInputId),
        message_index: 0,
        block_index: 0,
        timestamp: '2026-08-18T00:10:00.000Z',
      } as AgentMessage;
      appendConversationBatch({ projectRoot: root }, [started]);
      expect(readConversation(root, SESSION).sourceRows[0]).toEqual(started);

      const bundleMarker = 'INHERITED-LLM-TURN-STARTED-REPEAT-BUNDLE';
      const bundleBody = '-fixture'.repeat(80).concat(bundleMarker, '-bulk'.repeat(7_000));
      const resultContent = JSON.stringify({ success: true, data: { content: bundleBody } });
      const bundlePolicies = toolRowPolicies({ content: resultContent, template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
      const callId = 'repeat-visible-call';
      const bundle: AgentMessage[] = [
        {
          id: `${inheritedInputId}:tool-call:${callId}`,
          session_id: SESSION,
          role: 'assistant',
          kind: 'tool_call',
          tool: 'read',
          tool_call_id: callId,
          content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }] }),
          context_policy: bundlePolicies.call,
          round_id: deterministicRoundId('assistant', inheritedInputId),
          message_index: 2,
          block_index: 0,
          timestamp: '2026-08-18T00:10:01.000Z',
        } as AgentMessage,
        {
          id: `${inheritedInputId}:tool-result:${callId}`,
          session_id: SESSION,
          role: 'tool',
          kind: 'tool_result',
          tool: 'read',
          tool_call_id: callId,
          content: resultContent,
          context_policy: bundlePolicies.result,
          round_id: deterministicRoundId('assistant', inheritedInputId),
          message_index: 3,
          block_index: 0,
          timestamp: '2026-08-18T00:10:02.000Z',
        } as AgentMessage,
      ];
      appendConversationBatch({ projectRoot: root }, bundle);

      const conversation = readConversation(root, SESSION);
      expect(conversation.sourceRows.map((row) => row.id)).toEqual([started.id, ...bundle.map((row) => row.id)]);
      const preparedInvocation = invocation(conversation);
      expect(shouldCompact(preparedInvocation)).toBe(true);

      const classified = classifyConversationRounds(conversation);
      expect(classified.preamble).toEqual([]);
      expect(classified.rounds).toHaveLength(1);
      expect(classified.rounds[0]!.rows.map((row) => row.message.id)).toEqual([started.id, ...bundle.map((row) => row.id)]);
      expect(conversation.rounds).toHaveLength(1);
      expect(conversation.rounds[0]).toMatchObject({
        state: 'open',
        activation: { source: 'compacted_genesis', marker_id: 'activation-1', input_id: inheritedInputId },
      });
      expect(conversation.rounds.some((round) => round.activation.source === 'row')).toBe(false);
      expect(conversation.safeSourcePrefixEnds).toEqual([1, 3]);
      expect(conversation.sourceRows.slice(0, conversation.safeSourcePrefixEnds[0]).map((row) => row.id)).toEqual([started.id]);
      expect(conversation.safeSourcePrefixEnds).not.toContain(2);
      expect(conversation.sourceRows.slice(1, conversation.safeSourcePrefixEnds[1]).map((row) => row.id)).toEqual(bundle.map((row) => row.id));
      expect(conversation.calls).toHaveLength(1);
      expect(conversation.calls[0]).toMatchObject({ sourceIndex: 1, resultSourceIndex: 2 });

      const fullComposition = composedOf(conversation);
      const omittedStructuralComposition = composeContextProjection({
        sourceSessionId: conversation.sourceSessionId,
        effectiveHistory: {
          summaryText: inheritedSummary,
          historyMessageId: `${predecessorGenesis.id}:compacted-history`,
          historyTimestamp: predecessorGenesis.timestamp,
          requiredModelFacts: predecessor.conversation.effectiveCompactedHistory!.requiredModelFacts,
          protectedPrompts: predecessor.conversation.effectiveCompactedHistory!.protectedPrompts,
        },
        dynamicBlocks: [],
        uncoveredRows: conversation.sourceRows.slice(1),
      });
      expect(fullComposition.summarizer).toEqual(omittedStructuralComposition.summarizer);
      expect(providerConversationFromComposedContext(fullComposition)).toEqual(providerConversationFromComposedContext(omittedStructuralComposition));
      const rejectedTokens = preparedInvocation.providerConversation.messages.reduce((sum, row) => sum + (row.kind === 'synthetic_context' ? Math.max(1, Math.ceil(Buffer.byteLength(`${row.role} ${row.kind} ${row.origin} ${row.block_identity} ${row.content}`, 'utf8') / 4)) : estimateMessageTokens(row)), 0);
      expect(rejectedTokens).toBeGreaterThan(preparedInvocation.preparedCompaction.triggerMessageThreshold);
      expect(readConversationCatalog(root, SESSION).versions).toEqual(predecessorCatalog.versions);

      const result = await compact({
        strategy: 'preventive',
        conversations: { projectRoot: root },
        input: preparedInvocation,
        summarizerProvider: recordingSummarizer(repeatCalls),
        signal: new AbortController().signal,
      }).catch((error: unknown) => {
        expect(repeatCalls).toEqual([]);
        expect(readConversationCatalog(root, SESSION).versions).toEqual(predecessorCatalog.versions);
        throw error;
      });

      expect(result.kind).toBe('compacted');
      if (result.kind !== 'compacted') throw new Error('repeat fixture must publish a compacted successor');
      expect(result.estimatedProviderMessageTokens).toBeLessThanOrEqual(preparedInvocation.preparedCompaction.triggerMessageThreshold);
      expect(repeatCalls.length).toBeGreaterThan(0);
      expect(repeatCalls[0]!.contents.some((content) => content.includes(bundleMarker))).toBe(true);
      expect(JSON.stringify(repeatCalls[0])).not.toContain('llm_turn_started');
      const repeatRefineCalls = refineCalls(repeatCalls);
      expect(repeatRefineCalls.length).toBeGreaterThan(0);
      const inheritedHistoryInputs = repeatRefineCalls.map((call) => {
        const inheritedInputs = parseSummaryContents(call).filter(({ label }) => label === '[kind=inherited_history]');
        expect(inheritedInputs).toHaveLength(1);
        return inheritedInputs[0]!.body;
      });
      expect(inheritedHistoryInputs).toEqual([
        inheritedSummary,
        ...repeatRefineCalls.slice(0, -1).map((call) => call.result),
      ]);
      expect(inheritedHistoryInputs.filter((body) => body === inheritedSummary)).toHaveLength(1);
      expect(repeatCalls.flatMap((call) => call.contents).join('').split(bundleMarker)).toHaveLength(2);
      expect(JSON.stringify(repeatCalls)).not.toContain(EMPTY_COVERAGE_SUMMARY);

      const successorCatalog = readConversationCatalog(root, SESSION);
      expect(successorCatalog.versions).toHaveLength(predecessorCatalog.versions.length + 1);
      expect(successorCatalog.versions.slice(0, -1)).toEqual(predecessorCatalog.versions);
      const successor = readCurrentConversationSegment(root, SESSION)!;
      const successorGenesis = successor.genesis;
      if (successorGenesis.kind !== 'compacted_segment_genesis') throw new Error('repeat fixture successor must be compacted');
      expect(successor.entry.version).toBe(predecessor.entry.version + 1);
      expect(successorGenesis.source.version).toBe(predecessor.entry.version);
      expect(successorGenesis.compaction.source).toMatchObject({
        kind: 'prior_genesis_plus_current_rows',
        priorGenesisId: predecessorGenesis.id,
        priorHistoryHash: canonicalValueSha256(predecessorGenesis.compaction),
      });
      expect(successorGenesis.compaction.coverageCommitment.coveredThroughMessageId).toBe(bundle[1]!.id);
      expect(conversation.sourceRows.findIndex((row) => row.id === successorGenesis.compaction.coverageCommitment.coveredThroughMessageId) + 1).toBeGreaterThan(1);
      expect(successorGenesis.compaction.source.groups.map((group) => group.message_ids)).toEqual([
        [started.id],
        bundle.map((row) => row.id),
      ]);
      expect(successorGenesis.compaction.summaryText).not.toContain(EMPTY_COVERAGE_SUMMARY);
      expect(successor.rows).toEqual([]);
      expect(result.providerConversation).toEqual(providerConversationProjection(successor.conversation, []));
      expect(readHistoricalConversationSegment(root, SESSION, predecessor.entry.version).genesis).toEqual(predecessorGenesis);
      expect(readConversation(root, SESSION).effectiveCompactedHistory).toEqual(successorGenesis.compaction);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never covers an unmatched call and keeps it in the verbatim tail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-unmatched-'));
    initProjectTree(root);
    try {
      const callPolicy = toolRowPolicies({ content: '', template: OPERATIONAL_RESULT_POLICY_TEMPLATE });
      const unmatchedCall: AgentMessage = {
        id: '00000000-0000-4000-8000-000000000003:tool-call:call-9',
        session_id: SESSION,
        role: 'assistant',
        kind: 'tool_call',
        tool: 'read',
        tool_call_id: 'call-9',
        content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-9', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
        context_policy: callPolicy.call,
        round_id: `r-assistant-${'6'.repeat(32)}`,
        message_index: 2,
        block_index: 0,
        timestamp: '2026-08-18T00:00:07.000Z',
      } as AgentMessage;
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), unmatchedCall]);
      const conversation = readConversation(root, SESSION);
      const result = await compact({ strategy: 'authoritative_context_recovery', conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: recordingSummarizer([]), signal: new AbortController().signal });
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.rows.map((row) => row.id)).toEqual([unmatchedCall.id]);
      const projected = providerConversationProjection(segment.conversation, []).messages;
      expect(projected.some((row) => row.kind !== 'synthetic_context' && row.id === unmatchedCall.id)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns no_smaller_projection without appending or publishing when no new coverage exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-no-smaller-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', 'tiny')]);
      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'authoritative_context_recovery', calls);
      expect(result.kind).toBe('no_smaller_projection');
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('ordinary_segment_genesis');
      expect(segment.rows).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects covered recovery rows without the exact canonical warning and refusal markers that are not terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-slot-identity-'));
    initProjectTree(root);
    try {
      const malformed: AgentMessage = { ...recoveryNotice(1), content: 'not the canonical warning' };
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), malformed, activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      await expect(compactOnce(root, 'preventive', [])).rejects.toThrow(/does not carry the exact canonical recovery warning/);
    } finally { rmSync(root, { recursive: true, force: true }); }

    const root2 = mkdtempSync(join(tmpdir(), 'compaction-history-slot-terminal-'));
    initProjectTree(root2);
    try {
      appendConversationBatch({ projectRoot: root2 }, [activation(1), text('t1', BIG), refusalMarker(1), text('after-refusal', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      await expect(compactOnce(root2, 'preventive', [])).rejects.toThrow(/terminal row of its activation/);
    } finally { rmSync(root2, { recursive: true, force: true }); }
  });

  it('fails clearly when an old-format compacted segment is read by the current validators', () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-old-format-'));
    initProjectTree(root);
    try {
      const v1Name = '1-00000000-0000-4000-8000-000000000001.jsonl';
      const v2Name = '2-00000000-0000-4000-8000-000000000002.jsonl';
      const agentRoot = join(root, '.saivage', 'cards', 'project', 'conversations', 'planner');
      mkdirSync(join(agentRoot, 'versions'), { recursive: true });
      const v1Envelope = { version: 1, type: 'conversation-segment', rows: [{ format_version: 1, kind: 'ordinary_segment_genesis', id: '00000000-0000-4000-8000-0000000000aa', entry_id: '00000000-0000-4000-8000-0000000000bb', session_id: SESSION, segment_version: 1, timestamp: '2026-08-18T00:00:00.000Z' }] };
      const oldGenesis = {
        format_version: 1,
        kind: 'compacted_segment_genesis',
        id: '00000000-0000-4000-8000-0000000000cc',
        entry_id: '00000000-0000-4000-8000-0000000000dd',
        session_id: SESSION,
        segment_version: 2,
        timestamp: '2026-08-18T00:01:00.000Z',
        source: { version: 1, filename: v1Name, sha256: '0'.repeat(64), covered_through_message_id: 'activation-1' },
        compaction: { boundary: 'round', retained_static_message_ids: [], summaries: [], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 0, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, tail_fraction: 0.25, snap: 'compact_straddler' } },
        continuation: { kind: 'between_rounds' },
        retained_rows: { first_message_id: null, last_message_id: null, row_count: 0, static_row_count: 0, tail_row_count: 0, tail_first_message_id: null, sha256: '1'.repeat(64) },
      };
      const v2Envelope = { version: 1, type: 'conversation-segment', rows: [oldGenesis] };
      writeFileSync(join(agentRoot, 'versions', v1Name), `${JSON.stringify(v1Envelope)}\n`);
      writeFileSync(join(agentRoot, 'versions', v2Name), `${JSON.stringify(v2Envelope)}\n`);
      const index = {
        format_version: 1,
        kind: 'conversation-version-index',
        session_id: SESSION,
        created_at: '2026-08-18T00:00:00.000Z',
        versions: [
          { entry_id: '00000000-0000-4000-8000-0000000000bb', version: 1, filename: v1Name, created_at: '2026-08-18T00:00:00.000Z', genesis: { kind: 'ordinary' } },
          { entry_id: '00000000-0000-4000-8000-0000000000dd', version: 2, filename: v2Name, created_at: '2026-08-18T00:01:00.000Z', genesis: { kind: 'compacted', source_version: 1, source_filename: v1Name, source_sha256: '0'.repeat(64), covered_through_message_id: 'activation-1', compaction_payload_sha256: '2'.repeat(64), continuation_sha256: '3'.repeat(64), retained_rows_sha256: '1'.repeat(64) } },
        ],
        current_version: 2,
        current_filename: v2Name,
      };
      writeFileSync(join(agentRoot, 'index.json'), `${JSON.stringify(index)}\n`);
      expect(() => readCurrentConversationSegment(root, SESSION)).toThrow(/malformed|invalid/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
