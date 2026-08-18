import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { compact, prepareCompaction, shouldCompact, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { computeSlidingCompactionBands } from '../../src/runtime/actors/compaction/bands.js';
import { estimateMessageTokens, type ClassifiedRound } from '../../src/runtime/actors/compaction/round-classifier.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { conversationSessionIdentity, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const config: AutonomousCompactionPolicy = { input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };
const TEST_CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;

describe('Stage-I versioned compaction', () => {
  it('retains route-independent budgets and newest-relative partitions', () => {
    const prepared = prepareCompaction(config, 'system', []); expect(prepared.requestedCompletionTokens).toBe(2000);
    const messages: AgentMessage[] = [{ id: 'm', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'x'.repeat(4000), context_policy: TEXT_ROW_POLICY, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }];
    expect(shouldCompact(invocationFor('agent:planner:project', messages))).toBe(messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0) >= prepared.triggerMessageThreshold);
    const rounds = [1, 2, 3, 4, 5].map((value) => round(`round-${value}`, 10)); const bands = computeSlidingCompactionBands(rounds, { tail_budget_tokens: 20, middle_budget_tokens: 10, snap: 'compact_straddler' });
    expect(bands.merge_rounds.map((value) => value.round_id)).toEqual(['round-1']); expect(bands.open_round?.round_id).toBe('round-5');
  });

  it('publishes a compacted segment head while preserving v1 as explicit history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-versioned-compaction-')); initProjectTree(root);
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRound(root, ordinal);
      const before = readConversation(root, SESSION); const result = await compact({ strategy: 'preventive', conversations: { projectRoot: root }, input: invocationFor(SESSION, providerConversationProjection(before).messages), summarizerProvider: { candidate: TEST_CANDIDATE, serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }, signal: new AbortController().signal });
      expect(result.kind).toBe('compacted'); const current = readCurrentConversationSegment(root, SESSION)!;
      expect(current.entry.version).toBe(2); expect(current.genesis.kind).toBe('compacted_segment_genesis'); expect(current.rows.some((row) => row.kind === ('context_compaction' as never))).toBe(false);
      expect(readHistoricalConversationSegment(root, SESSION, 1).genesis.kind).toBe('ordinary_segment_genesis');
      const projected = providerConversationProjection(current.conversation).messages; expect(projected.filter((row) => row.id.endsWith(':compacted-history'))).toHaveLength(1); expect(projected[0]!.content).toBe(current.conversation.effectiveCompactedHistory!.summaryText);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

const SESSION = 'agent:planner:project' as const;
function appendRound(root: string, ordinal: number): void { const timestamp = `2026-08-11T00:${String(ordinal).padStart(2, '0')}:00.000Z`; appendConversationBatch({ projectRoot: root }, [{ id: `activation-${ordinal}`, session_id: SESSION, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id: SESSION, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(400), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]); }
function invocationFor(sessionId: ConversationSessionId, messages: readonly AgentMessage[]): PreparedLlmInvocationInput { const agentName = conversationSessionIdentity(sessionId).agentName; const preparedCompaction = prepareCompaction(config, 'system', []); return { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName, sessionId, systemPrompt: 'system', providerConversation: { sourceSessionId: sessionId, messages: [...messages] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [TEST_CANDIDATE] }, episodeContext: {} }; }
function round(id: string, tokens: number): ClassifiedRound { const message: AgentMessage = { id: `${id}-m`, session_id: SESSION, role: 'user', kind: 'text', content: 'x', context_policy: TEXT_ROW_POLICY, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }; const positioned = { message, estimated_tokens: tokens }; return { round_id: id, state: id === 'round-5' ? ('open' as const) : ('closed' as const), activation_marker: positioned, rows: [positioned], sub_rounds: [], estimated_tokens: tokens }; }
