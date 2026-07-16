import { describe, expect, it } from '@jest/globals';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { deriveStage1CompactionBudget, validateCompactionStaticCapacity, type CompactionConfig } from '../../src/runtime/actors/compaction/compactor.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands } from '../../src/runtime/actors/compaction/bands.js';
import type { ClassifiedRound } from '../../src/runtime/actors/compaction/round-classifier.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema } from '../../src/schemas/index.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { compact } from '../../src/runtime/actors/compaction/compactor.js';
import { conversationMessagesForModel } from '../../src/runtime/actors/conversation-session.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };

describe('Stage-I compaction contracts', () => {
  it('requires route-independent budget and derives one completion authority', () => {
    expect(saivageConfigSchema.safeParse({ compaction: { ...config, input_budget_tokens: undefined } }).success).toBe(false);
    const budget = deriveStage1CompactionBudget(config);
    expect(budget).toMatchObject({ inputBudgetTokens: 1000, requestedCompletionTokens: 200, normalTailBudget: 300, normalMiddleBudget: 200, escalatedTailBudget: 250, escalatedMiddleBudget: 150 });
  });

  it('rejects each wider escalated width with the exact derived diagnostic', () => {
    const tail = saivageConfigSchema.safeParse({ compaction: { ...config, escalate_summary_line_fraction: 0.4, escalate_merge_line_fraction: 0.1 } });
    expect(tail.success).toBe(false);
    if (!tail.success) expect(tail.error.issues.map((issue) => issue.message)).toContain('Escalated compaction tail width must be <= normal tail width (trigger - summary): escalated=0.4, normal=0.30000000000000004.');
    const middle = saivageConfigSchema.safeParse({ compaction: { ...config, escalate_summary_line_fraction: 0.6, escalate_merge_line_fraction: 0.2 } });
    expect(middle.success).toBe(false);
    if (!middle.success) expect(middle.error.issues.some((issue) => issue.message.startsWith('Escalated compaction middle width must be <= normal middle width'))).toBe(true);
  });

  it('validates exact static capacity independently of any route', () => {
    const budget = validateCompactionStaticCapacity(config, 'system', []);
    expect(budget.requestedCompletionTokens).toBe(200);
    expect(budget.triggerMessageThreshold).toBeGreaterThan(0);
    expect(() => validateCompactionStaticCapacity({ ...config, input_budget_tokens: 10 }, 'x'.repeat(100), [])).toThrow(/does not fit the compaction budget/);
  });

  it('partitions completed rounds newest-relative and asserts escalation suffixes', () => {
    const rounds = [1, 2, 3, 4, 5].map((ordinal) => round(`round-${ordinal}`, 10));
    const normal = computeSlidingCompactionBands(rounds, { tail_budget_tokens: 20, middle_budget_tokens: 10, snap: 'compact_straddler' });
    const escalated = computeSlidingCompactionBands(rounds, { tail_budget_tokens: 10, middle_budget_tokens: 10, snap: 'compact_straddler' });
    expect(normal.merge_rounds.map((value) => value.round_id)).toEqual(['round-1']);
    expect(normal.summary_rounds.map((value) => value.round_id)).toEqual(['round-2']);
    expect(normal.tail_rounds.map((value) => value.round_id)).toEqual(['round-3', 'round-4']);
    expect(normal.open_round?.round_id).toBe('round-5');
    expect(() => assertEscalatedSuffixSubsets(normal, escalated)).not.toThrow();
  });

  it('requires a system row containing strict canonical JSON text', () => {
    const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: ['m1'] }] }], content_hash: 'a'.repeat(64), summary_text: 'summary', evidence: [] }], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, requested_completion_tokens: 200, canonical_message_hard_ceiling: 790, trigger_line_tokens: 800, trigger_message_threshold: 790, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, tail_budget_tokens: 300, middle_budget_tokens: 200, snap: 'compact_straddler' } });
    const row = { id: 'c1', session_id: 'planner:project', role: 'system', kind: 'context_compaction', content: canonicalJson(payload), round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
    expect(agentMessageSchema.parse(row).content).toBe(canonicalJson(payload));
    expect(agentMessageSchema.safeParse({ ...row, role: 'user' }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ ...row, content: JSON.stringify(payload, null, 2) }).success).toBe(false);
    expect(contextCompactionContentSchema.safeParse({ ...payload, cutoff: { round_id: 'm1', through_message_id: 'm1', boundary: 'round' } }).success).toBe(false);
  });

  it.each(['compact_straddler', 'keep_straddler_verbatim'] as const)('appends C1/C2/C3 latest-only raw-authoritative projections with a monotonic cutoff (%s)', async (snap) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-stage-i-'));
    try {
      for (let ordinal = 1; ordinal <= 4; ordinal++) appendRawRound(root, ordinal);
      const provider = { completeTurn: async () => ({ result: { kind: 'message' as const, content: 'short raw-derived summary' }, provider_exchanges: [] }) };
      const integrationConfig: CompactionConfig = { ...config, input_budget_tokens: 400, snap };
      const invocation = { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner' as const, sessionId: 'planner:project', systemPrompt: 'system', genericContextMessages: [], contextMessages: [], activeConversationReplay: { sessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 80 }, capabilityRequest: { requestedCompletionTokens: 80 }, episodeContext: {} };
      await compact({ projectRoot: root, conversations: { projectRoot: root }, sessionId: 'planner:project', input: invocation, config: integrationConfig, summarizerProvider: provider, signal: new AbortController().signal });
      const first = readConversation(root, 'planner:project');
      const firstCutoff = first.latestCompaction!.cutoffMessageId;
      for (let ordinal = 5; ordinal <= 7; ordinal++) appendRawRound(root, ordinal);
      await compact({ projectRoot: root, conversations: { projectRoot: root }, sessionId: 'planner:project', input: { ...invocation, inputId: '00000000-0000-4000-8000-000000000002', genericContextMessages: conversationMessagesForModel(first), contextMessages: conversationMessagesForModel(first) }, config: integrationConfig, summarizerProvider: provider, signal: new AbortController().signal });
      const second = readConversation(root, 'planner:project');
      const metadata = second.physicalRows.filter((row) => row.kind === 'context_compaction');
      expect(metadata).toHaveLength(2);
      const secondPayload = second.latestCompaction!.payload;
      const sourceIds = second.sourceRows.map((row) => row.id);
      expect(sourceIds.indexOf(second.latestCompaction!.cutoffMessageId)).toBeGreaterThan(sourceIds.indexOf(firstCutoff));
      expect(secondPayload.summaries.flatMap((group) => group.rounds.flatMap((round) => round.segments.flatMap((segment) => segment.source_message_ids))).every((id) => sourceIds.includes(id))).toBe(true);
      const projected = conversationMessagesForModel(second);
      expect(projected.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(projected.some((row) => row.kind === 'context_compaction')).toBe(false);
      for (let ordinal = 8; ordinal <= 10; ordinal++) appendRawRound(root, ordinal);
      await compact({ projectRoot: root, conversations: { projectRoot: root }, sessionId: 'planner:project', input: { ...invocation, inputId: '00000000-0000-4000-8000-000000000003', genericContextMessages: conversationMessagesForModel(second), contextMessages: conversationMessagesForModel(second) }, config: integrationConfig, summarizerProvider: provider, signal: new AbortController().signal });
      const third = readConversation(root, 'planner:project');
      const allMetadata = third.physicalRows.filter((row) => row.kind === 'context_compaction');
      expect(allMetadata).toHaveLength(3);
      const thirdPayload = third.latestCompaction!.payload;
      expect(sourceIds.indexOf(second.latestCompaction!.cutoffMessageId)).toBeLessThan(third.sourceRows.map((row) => row.id).indexOf(third.latestCompaction!.cutoffMessageId));
      const thirdProjection = conversationMessagesForModel(third);
      expect(thirdProjection.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(thirdProjection.some((row) => row.content === third.compactions[0]!.renderedContext)).toBe(false);
      expect(thirdProjection.some((row) => row.content === third.compactions[1]!.renderedContext)).toBe(false);
      expect(thirdPayload.summaries.flatMap((group) => group.rounds.flatMap((round) => round.segments.flatMap((segment) => segment.source_message_ids))).every((id) => third.sourceRows.some((row) => row.id === id))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses hard-limit fallback for an oversized open round while preserving a safe verbatim suffix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-hard-limit-'));
    try {
      const session_id = 'planner:project';
      const source_input_id = '00000000-0000-4000-8000-000000000099';
      const rows = [
        { id: 'hard-activation', session_id, role: 'system' as const, kind: 'activity' as const, content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: source_input_id }), round_id: 'r-pre-99999999999999999999999999999999', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:01:00.000Z' },
        ...Array.from({ length: 10 }, (_, index) => ({ id: `hard-message-${index}`, session_id, role: 'user' as const, kind: 'text' as const, content: `${index}:${'x'.repeat(320)}`, round_id: 'r-user-99999999999999999999999999999999', message_index: index + 1, block_index: 0, timestamp: '2026-07-15T00:01:00.000Z' })),
      ];
      appendConversationBatch(root, rows);
      const provider = { completeTurn: async () => ({ result: { kind: 'message' as const, content: 'small prefix summary' }, provider_exchanges: [] }) };
      const hardConfig: CompactionConfig = { ...config, input_budget_tokens: 400 };
      const invocation = { inputId: source_input_id, agentId: session_id, role: 'planner' as const, sessionId: session_id, systemPrompt: 'system', genericContextMessages: rows, contextMessages: rows, activeConversationReplay: { sessionId: session_id, messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 80 }, capabilityRequest: { requestedCompletionTokens: 80 }, episodeContext: {} };

      const result = await compact({ projectRoot: root, conversations: { projectRoot: root }, sessionId: session_id, input: invocation, config: hardConfig, summarizerProvider: provider, signal: new AbortController().signal });
      const payload = contextCompactionContentSchema.parse(JSON.parse(result.compactionMessage.content));
      expect(payload.applied_policy.mode).toBe('hard_limit_fallback');
      expect(payload.summaries.at(-1)?.rounds[0]?.complete).toBe(false);
      const projected = conversationMessagesForModel(readConversation(root, session_id));
      expect(projected.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(projected.some((row) => row.id === 'hard-message-9')).toBe(true);
      expect(readConversation(root, session_id).latestCompaction!.cutoffMessageId).not.toBe('hard-message-9');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function round(id: string, tokens: number): ClassifiedRound {
  const message = { id: `${id}-m`, session_id: 'planner:project', role: 'user' as const, kind: 'text' as const, content: 'x', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
  const positioned = { message, estimated_tokens: tokens, start_token: 0, end_token: tokens };
  return { round_id: id, activation_marker: positioned, rows: [positioned], sub_rounds: [], start_token: 0, end_token: tokens };
}

function appendRawRound(root: string, ordinal: number): void {
  const session_id = 'planner:project';
  const timestamp = `2026-07-15T00:00:${String(ordinal).padStart(2, '0')}.000Z`;
  appendConversationBatch(root, [{ id: `activation-${ordinal}`, session_id, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}` }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id, role: 'user', kind: 'text', content: `${ordinal}:${'x'.repeat(400)}`, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]);
}
