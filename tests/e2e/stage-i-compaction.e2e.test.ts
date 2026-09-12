import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { compact, prepareCompaction, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { ProviderConversationItem } from '../../src/agents/llm-contracts.js';
import { conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { cardConversationVersionIndexFile } from '../../src/persistence/layout.js';

const config: AutonomousCompactionPolicy = { input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, tail_fraction: 0.25, snap: 'compact_straddler' };
const TEST_CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;

describe('Stage-I versioned compaction', () => {
  it('retains route-independent budgets and the configured tail budget', () => {
    const prepared = prepareCompaction(config, 'system', []); expect(prepared.requestedCompletionTokens).toBe(2000);
    const messages: AgentMessage[] = [{ id: 'm', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'x'.repeat(4000), context_policy: TEXT_ROW_POLICY, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }];
    expect(shouldCompact(invocationFor('agent:planner:project', messages))).toBe(messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0) >= prepared.triggerMessageThreshold);
    expect(prepared.tailBudgetTokens).toBe(2500);
  });

  it('publishes a compacted segment head while preserving v1 as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-versioned-compaction-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const before = readConversation(root, SESSION); const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(before, []).messages), summarizerProvider: { candidate: TEST_CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal, progress: noCompactionProgress });
      expect(result.kind).toBe('compacted'); const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.entry.version).toBe(2); expect(current.genesis.kind).toBe('compacted_segment_genesis'); expect(current.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      const durableSummaryText = current.conversation.effectiveCompactedHistory!.summaryText;
      expect(durableSummaryText).toBe('summary');
      const projection = providerConversationProjection(current.conversation, []);
      if (projection.sourceSessionId === null) throw new Error('missing compacted provider conversation source');
      const projected = projection.messages;
      const boundaries = projected.filter((row) => row.kind === 'synthetic_context' && row.origin === 'context_boundary');
      const historySummaries = projected.filter((row) => row.kind === 'synthetic_context' && row.origin === 'history_summary');
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({ kind: 'synthetic_context', role: 'system', origin: 'context_boundary' });
      expect(boundaries[0]!.content).not.toHaveLength(0);
      expect(historySummaries).toHaveLength(1);
      expect(historySummaries[0]).toMatchObject({ kind: 'synthetic_context', role: 'system', origin: 'history_summary' });
      expect(projected.indexOf(historySummaries[0]!)).toBe(projected.indexOf(boundaries[0]!) + 1);
      const summaryRequestPrefix = 'Historical summary:\n';
      expect(historySummaries[0]!.content.startsWith(summaryRequestPrefix)).toBe(true);
      expect(historySummaries[0]!.content.slice(summaryRequestPrefix.length)).toBe(durableSummaryText);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('walks multiple cutoffs with disjoint raw inputs, sequential calls, and one canonical selected successor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-incremental-compaction-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const before = readConversation(root, SESSION);
      const rawRequests: string[][] = [];
      let activeCalls = 0;
      let maximumActiveCalls = 0;
      const result = await compact({
        strategy: 'local_exact_admission', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(before, []).messages),
        summarizerProvider: {
          candidate: TEST_CANDIDATE,
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
          serializeSummaryRequest: deterministicSummarySerialization,
          completeTurn: async (input) => {
            activeCalls++;
            maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
            rawRequests.push(input.providerConversation.messages.map((row) => row.content));
            await Promise.resolve();
            activeCalls--;
            return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
          },
          projectProviderExchanges: jest.fn(),
        }, signal: new AbortController().signal, progress: noCompactionProgress,
      });
      expect(result.kind).toBe('compacted');
      expect(maximumActiveCalls).toBe(1);
      const allInputs = rawRequests.flat();
      for (let ordinal = 1; ordinal <= 7; ordinal++)
        expect(allInputs.filter((content) => content.includes(`source=message-${ordinal}`))).toHaveLength(1);
      const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.entry.version).toBe(2);
      expect(current.rows).toEqual([]);
      expect(current.conversation.effectiveCompactedHistory!.coverageCommitment.coveredThroughMessageId).toBe('message-7');
      expect(readHistoricalConversationSegment(root, SESSION, 1).rows).toHaveLength(14);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an already-aborted persisted compaction before oversized summary work or canonical head changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-aborted-compaction-')); initProjectTree(root);
    try {
      appendRound(root, 1);
      const before = readCurrentConversationSegment(root, SESSION)!;
      const indexPath = cardConversationVersionIndexFile(root, 'project', 'planner');
      const beforeIndexBytes = readFileSync(indexPath);
      const reason = new Error('cancel persisted compaction before admission');
      const controller = new AbortController();
      controller.abort(reason);
      const serializeSummaryRequest = jest.fn((input: Parameters<typeof deterministicSummarySerialization>[0]) => ({
        ...deterministicSummarySerialization(input),
        estimatedInputTokens: 100_000,
      }));
      const completeTurn = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unexpected' }, provider_exchanges: [] }));
      const projectProviderExchanges = jest.fn();
      const foldStarted = jest.fn();
      const foldCompleted = jest.fn();

      await expect(compact({
        strategy: 'preventive',
        conversations: { projectRoot: root },
        input: invocationFor(SESSION, providerConversationProjection(before.conversation, []).messages),
        summarizerProvider: { candidate: TEST_CANDIDATE, contextWindowTokens: 100_000, maxOutputTokens: 10_000, serializeSummaryRequest, completeTurn, projectProviderExchanges },
        signal: controller.signal,
        progress: { foldStarted, foldCompleted, foldFailed: jest.fn() },
      })).rejects.toBe(reason);

      expect(serializeSummaryRequest).not.toHaveBeenCalled();
      expect(completeTurn).not.toHaveBeenCalled();
      expect(projectProviderExchanges).not.toHaveBeenCalled();
      expect(foldStarted).not.toHaveBeenCalled();
      expect(foldCompleted).not.toHaveBeenCalled();
      expect(readFileSync(indexPath)).toEqual(beforeIndexBytes);
      const after = readCurrentConversationSegment(root, SESSION)!;
      expect(after.index).toEqual(before.index);
      expect(after.entry).toEqual(before.entry);
      expect(after.genesis).toEqual(before.genesis);
      expect(after.rows).toEqual(before.rows);
      expect(after.bytes).toEqual(before.bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const SESSION = 'agent:planner:project' as const;
function appendRound(root: string, ordinal: number): void { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; appendConversationBatch({ projectRoot: root }, [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(400), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]); }
function invocationFor(sessionId: ConversationSessionId, messages: readonly ProviderConversationItem[]): PreparedLlmInvocationInput { const agentName = conversationSessionIdentity(sessionId).agentName; const preparedCompaction = prepareCompaction(config, 'system', []); return { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName, sessionId, systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [...messages] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [TEST_CANDIDATE] }, episodeContext: {} }; }
