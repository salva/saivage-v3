import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { appendConversationBatch, foldConversation, readConversation, readConversationCatalog, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { compact, prepareCompaction, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { composeContextProjection, type ComposedContextProjection } from '../../src/runtime/actors/context/composition-projector.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import {
  contentPolicyRefusalProjectionText,
  MODEL_RECOVERY_NOTICE_TEXT,
  STRUCTURAL_ROW_POLICY,
  type AgentMessage,
} from '../../src/schemas/index.js';
import type { ValidatedConversation } from '../../src/contracts/conversation-validation.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { SUMMARY_REDUCTION_INSTRUCTION } from '../../src/runtime/actors/compaction/summary-materializer.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = { input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };
const BIG = 'x'.repeat(12_000);

type SummaryCall = { systemPrompt: string; contents: string[] };

function recordingSummarizer(calls: SummaryCall[]) {
  return {
    candidate: CANDIDATE,
    serializeSummaryRequest: deterministicSummarySerialization,
    completeTurn: async (input: PreparedLlmInvocationInput) => {
      calls.push({ systemPrompt: input.systemPrompt, contents: input.providerConversation.messages.map((row) => row.content) });
      const previews = input.providerConversation.messages.map((row) => row.content.split('\n').slice(1).join('\n').slice(0, 120)).join('|');
      if (input.systemPrompt === SUMMARY_REDUCTION_INSTRUCTION) {
        return { result: { kind: 'message' as const, content: `merge[${previews}]` }, provider_exchanges: [] };
      }
      return { result: { kind: 'message' as const, content: `round[${previews}]` }, provider_exchanges: [] };
    },
    projectProviderExchanges: jest.fn(),
  };
}

function reductionCalls(calls: readonly SummaryCall[]): SummaryCall[] {
  return calls.filter((call) => call.systemPrompt === SUMMARY_REDUCTION_INSTRUCTION);
}

function invocation(conversation: ValidatedConversation): PreparedLlmInvocationInput {
  const providerConversation = providerConversationProjection(conversation);
  const preparedCompaction = prepareCompaction(POLICY, 'system', []);
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
      ? { summaryText: history.summaryText, historyMessageId: `${genesis.id}:compacted-history`, historyTimestamp: genesis.timestamp, requiredModelFacts: history.requiredModelFacts }
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
    context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience, evidence: { kind: 'none' } },
    content,
    round_id: `r-user-${'2'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: '2026-08-18T00:00:01.000Z',
  } as AgentMessage;
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
      const beforeClose = providerConversationProjection(closedConversation).messages;
      expect(beforeClose.some((row) => row.content.includes(bundleBody))).toBe(true);
      const afterLaterInvocation = providerConversationProjection(readConversation(root, SESSION)).messages;
      expect(afterLaterInvocation.some((row) => row.content.includes(bundleBody))).toBe(true);
      expect(readConversationCatalog(root, SESSION).versions).toHaveLength(1);

      const calls: SummaryCall[] = [];
      const result = await compactOnce(root, 'preventive', calls);
      expect(result.kind).toBe('compacted');
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.rows.some((row) => row.content.includes(bundleBody))).toBe(false);
      const projected = providerConversationProjection(segment.conversation).messages;
      expect(projected.some((row) => row.content.includes(bundleBody))).toBe(false);
      expect(segment.conversation.effectiveCompactedHistory!.summaryText.includes('OPERATIONAL-FINDINGS')).toBe(true);
      expect(projected.some((row) => row.content === segment.conversation.effectiveCompactedHistory!.summaryText)).toBe(true);
      expect(calls.some((call) => call.contents.some((content) => content.includes('OPERATIONAL-FINDINGS')))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('creates no coverage, publication, or omission when the summary attempt fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-history-failure-'));
    initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [activation(1), text('t1', BIG), activation(2), text('t2', BIG), activation(3), text('t3', BIG)]);
      const conversation = readConversation(root, SESSION);
      const failing = {
        candidate: CANDIDATE,
        serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async () => { throw new Error('summary provider failed'); },
        projectProviderExchanges: jest.fn(),
      };
      await expect(compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocation(conversation), summarizerProvider: failing, signal: new AbortController().signal })).rejects.toThrow(/summary provider failed/);
      expect(readConversationCatalog(root, SESSION).versions.map(({ version }) => version)).toEqual([1]);
      const segment = readCurrentConversationSegment(root, SESSION)!;
      expect(segment.genesis.kind).toBe('ordinary_segment_genesis');
      expect(segment.rows).toHaveLength(6);
      expect(providerConversationProjection(segment.conversation).messages.some((row) => row.content === BIG)).toBe(true);
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
      const primary1 = providerConversationProjection(gen1.conversation).messages;
      expect(primary1.filter((row) => row.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(primary1.filter((row) => row.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      const summarizer1 = composedOf(gen1.conversation).summarizer;
      expect(summarizer1.filter((item) => item.kind === 'message' && item.content === MODEL_RECOVERY_NOTICE_TEXT)).toHaveLength(1);
      expect(summarizer1.filter((item) => item.kind === 'message' && item.content === contentPolicyRefusalProjectionText(SESSION, refusal2))).toHaveLength(1);
      expect(summarizer1[0]).toMatchObject({ kind: 'inherited_summary', content: history1.summaryText });
      expect(JSON.stringify(summarizer1)).not.toContain('RAW-REFUSAL');

      const bundleFiveBody = 'BUNDLE-FIVE'.concat('-five'.repeat(4000));
      appendConversationBatch({ projectRoot: root }, [activation(4), text('t4', BIG), text('eo-4', 'EVIDENCE-ROW-FOUR', 'evidence_only'), activation(5), ...summarizerOnlyBundle('00000000-0000-4000-8000-000000000005', 'call-5', bundleFiveBody), activation(6), text('t6', BIG)]);
      const preSecond = providerConversationProjection(readConversation(root, SESSION)).messages;
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
      const mergeInputs2 = reductionCalls(generationCalls[1]!);
      expect(mergeInputs2.length).toBeGreaterThan(0);
      expect(mergeInputs2.some((call) => call.contents.some((content) => content.includes(history1.summaryText)))).toBe(true);
      expect(mergeInputs2.some((call) => call.contents.some((content) => content.includes('superseded_')))).toBe(false);
      expect(gen2.rows.map((row) => row.id)).toEqual(['activation-6', 't6']);
      const projected2 = providerConversationProjection(gen2.conversation).messages;
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
      const mergeInputs3 = reductionCalls(generationCalls[2]!);
      expect(mergeInputs3.some((call) => call.contents.some((content) => content.includes(history2.summaryText)))).toBe(true);
      expect(mergeInputs3.some((call) => call.contents.some((content) => content.includes('superseded_')))).toBe(false);
      const projected3 = providerConversationProjection(gen3.conversation).messages;
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
      const mergeInputs2 = reductionCalls(calls2);
      expect(mergeInputs2.some((call) => call.contents.some((content) => content.includes(`superseded_refusal_notice source=${marker1}`)))).toBe(true);
      const projected = providerConversationProjection(gen2.conversation).messages;
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
      const projected = providerConversationProjection(segment.conversation).messages;
      expect(projected.some((row) => row.content.includes(openRoundBody))).toBe(false);
      expect(projected.some((row) => row.content === segment.conversation.effectiveCompactedHistory!.summaryText)).toBe(true);

      const repair: AgentMessage = {
        id: '00000000-0000-4000-8000-000000000009:model-repair',
        session_id: SESSION,
        role: 'user',
        kind: 'model_repair',
        context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } },
        content: 'repair directive after inherited open round',
        round_id: `r-user-${'5'.repeat(32)}`,
        message_index: 2,
        block_index: 0,
        timestamp: '2026-08-18T00:00:06.000Z',
      } as AgentMessage;
      appendConversationBatch({ projectRoot: root }, [repair]);
      const continued = readCurrentConversationSegment(root, SESSION)!;
      expect(continued.conversation.rounds[0]!.segments.map((segmentOfRound) => segmentOfRound.kind)).toEqual(['initial', 'repair']);
      const continuedProjection = providerConversationProjection(continued.conversation).messages;
      expect(continuedProjection.some((row) => row.content === 'repair directive after inherited open round')).toBe(true);
      expect(continuedProjection.some((row) => row.content === continued.conversation.effectiveCompactedHistory!.summaryText)).toBe(true);
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
      const projected = providerConversationProjection(segment.conversation).messages;
      expect(projected.some((row) => row.id === unmatchedCall.id)).toBe(true);
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
        compaction: { boundary: 'round', retained_static_message_ids: [], summaries: [], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 0, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' } },
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
