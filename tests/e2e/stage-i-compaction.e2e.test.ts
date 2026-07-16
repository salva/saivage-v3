import { describe, expect, it, jest } from '@jest/globals';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { prepareCompaction, shouldCompact, type CompactionConfig } from '../../src/runtime/actors/compaction/compactor.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands } from '../../src/runtime/actors/compaction/bands.js';
import { estimateMessageTokens, type ClassifiedRound } from '../../src/runtime/actors/compaction/round-classifier.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage } from '../../src/schemas/index.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { compact } from '../../src/runtime/actors/compaction/compactor.js';
import { conversationMessagesForModel } from '../../src/runtime/actors/conversation-session.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { hashConversationRows } from '../../src/contracts/conversation-compaction.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };

describe('Stage-I compaction contracts', () => {
  it('requires route-independent budget and derives one completion authority', () => {
    expect(saivageConfigSchema.safeParse({ compaction: { ...config, input_budget_tokens: undefined } }).success).toBe(false);
    const budget = prepareCompaction(config, 'system', []);
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
    const budget = prepareCompaction(config, 'system', []);
    expect(budget.requestedCompletionTokens).toBe(200);
    expect(budget.triggerMessageThreshold).toBeGreaterThan(0);
    expect(() => prepareCompaction({ ...config, input_budget_tokens: 10 }, 'x'.repeat(100), [])).toThrow(/does not fit the compaction budget/);
  });

  it('estimates the already-projected invocation sequence without changing estimator input', () => {
    const contextMessages = [agentMessageSchema.parse({ id: 'visible', session_id: 'planner:project', role: 'user', kind: 'text', content: 'projected context', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' })];
    const preparedCompaction = prepareCompaction(config, 'system', []);
    const invocation: LlmInvocationInput = { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner' as const, sessionId: 'planner:project', systemPrompt: 'system', genericContextMessages: contextMessages, contextMessages, activeConversationReplay: { sessionId: 'planner:project', messages: contextMessages }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction, capabilityRequest: {}, episodeContext: {} };
    expect(shouldCompact(invocation)).toBe(contextMessages.reduce((sum, row) => sum + estimateMessageTokens(row), 0) >= preparedCompaction.triggerMessageThreshold);
    expect(invocation.contextMessages).toBe(contextMessages);
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
    const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: ['m1'] }] }], content_hash: 'a'.repeat(64), summary_text: 'summary', evidence: [] }], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' } });
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
      const invocation = invocationFor('planner:project', [], integrationConfig);
      await compact({ conversations: { projectRoot: root }, input: invocation, summarizerProvider: provider, signal: new AbortController().signal });
      const first = readConversation(root, 'planner:project');
      const firstCutoff = first.latestCompaction!.cutoffMessageId;
      for (let ordinal = 5; ordinal <= 7; ordinal++) appendRawRound(root, ordinal);
      await compact({ conversations: { projectRoot: root }, input: { ...invocation, inputId: '00000000-0000-4000-8000-000000000002', genericContextMessages: conversationMessagesForModel(first), contextMessages: conversationMessagesForModel(first) }, summarizerProvider: provider, signal: new AbortController().signal });
      const second = readConversation(root, 'planner:project');
      const metadata = second.physicalRows.filter((row) => row.kind === 'context_compaction');
      expect(metadata).toHaveLength(2);
      const secondPayload = second.latestCompaction!.payload;
      const sourceIds = second.sourceRows.map((row) => row.id);
      expect(sourceIds.indexOf(second.latestCompaction!.cutoffMessageId)).toBeGreaterThan(sourceIds.indexOf(firstCutoff));
      expect(secondPayload.summaries.flatMap((group) => group.rounds.flatMap((round) => round.segments.flatMap((segment) => segment.source_message_ids))).every((id) => sourceIds.includes(id))).toBe(true);
      const projected = conversationMessagesForModel(second);
      expect(projected.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(projected.find((row) => row.id.endsWith(':rendered'))!.content).toBe(second.latestCompaction!.renderedContext);
      expect(projected.some((row) => row.kind === 'context_compaction')).toBe(false);
      for (let ordinal = 8; ordinal <= 10; ordinal++) appendRawRound(root, ordinal);
      await compact({ conversations: { projectRoot: root }, input: { ...invocation, inputId: '00000000-0000-4000-8000-000000000003', genericContextMessages: conversationMessagesForModel(second), contextMessages: conversationMessagesForModel(second) }, summarizerProvider: provider, signal: new AbortController().signal });
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
      const invocation = invocationFor(session_id, rows, hardConfig);

      const result = await compact({ conversations: { projectRoot: root }, input: invocation, summarizerProvider: provider, signal: new AbortController().signal });
      const payload = contextCompactionContentSchema.parse(JSON.parse(result.compactionMessage.content));
      expect(payload.applied_policy.mode).toBe('hard_limit_fallback');
      expect(payload.summaries.at(-1)?.rounds[0]?.complete).toBe(false);
      const projected = conversationMessagesForModel(readConversation(root, session_id));
      expect(projected.filter((row) => row.id.endsWith(':rendered'))).toHaveLength(1);
      expect(projected.some((row) => row.id === 'hard-message-9')).toBe(true);
      const first = readConversation(root, session_id);
      const firstCutoff = first.latestCompaction!.cutoffSourceIndex;
      expect(first.latestCompaction!.cutoffMessageId).not.toBe('hard-message-9');
      appendConversationBatch(root, [{ id: 'hard-message-10', session_id, role: 'user', kind: 'text', content: `10:${'x'.repeat(320)}`, round_id: 'r-user-99999999999999999999999999999999', message_index: 11, block_index: 0, timestamp: '2026-07-15T00:01:00.000Z' }]);
      const current = readConversation(root, session_id);
      await compact({ conversations: { projectRoot: root }, input: { ...invocation, inputId: '00000000-0000-4000-8000-000000000100', genericContextMessages: conversationMessagesForModel(current), contextMessages: conversationMessagesForModel(current) }, summarizerProvider: provider, signal: new AbortController().signal });
      const second = readConversation(root, session_id).latestCompaction!;
      expect(second.cutoffSourceIndex).toBeGreaterThan(firstCutoff);
      expect(second.groups.filter((group) => !group.rounds[0]!.complete)).toHaveLength(second.groups.at(-1)!.rounds[0]!.complete ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['planner:project', 'executor:project', 'reviewer:project'])('derives owner root and stable session only from conversations/input for %s', async (sessionId) => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-compaction-owner-'));
    const decoyRoot = mkdtempSync(join(tmpdir(), 'saivage-compaction-decoy-'));
    try {
      for (let ordinal = 1; ordinal <= 4; ordinal++) appendRawRound(ownerRoot, ordinal, sessionId);
      appendRawRound(decoyRoot, 1, sessionId);
      const changes = { conversationChanged: jest.fn(), agentsChanged: jest.fn(), runtimeChanged: jest.fn(), cardStateChanged: jest.fn(), subscribe: jest.fn(() => ({ unsubscribe() {} })) };
      const invocation = invocationFor(sessionId, [], { ...config, input_budget_tokens: 400 });
      await compact({ conversations: { projectRoot: ownerRoot, changes }, input: invocation, summarizerProvider: summaryProvider(), signal: new AbortController().signal });
      const owner = readConversation(ownerRoot, sessionId);
      expect(owner.compactions).toHaveLength(1);
      expect(owner.latestCompaction!.metadataRow.session_id).toBe(sessionId);
      expect(readConversation(decoyRoot, sessionId).compactions).toHaveLength(0);
      expect(changes.conversationChanged).toHaveBeenCalledWith(sessionId);
      expect(changes.agentsChanged).toHaveBeenCalled();
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
      rmSync(decoyRoot, { recursive: true, force: true });
    }
  });

  it('reuses a prior merged summary only as an exact validated source prefix/hash input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-reuse-'));
    try {
      for (let ordinal = 1; ordinal <= 7; ordinal++) appendRawRound(root, ordinal);
      const inputs: LlmInvocationInput[] = [];
      let ordinal = 0;
      const provider = { completeTurn: async (input: LlmInvocationInput) => { inputs.push(input); return { result: { kind: 'message' as const, content: `summary-${++ordinal}` }, provider_exchanges: [] }; } };
      const integrationConfig = { ...config, input_budget_tokens: 400 };
      await compact({ conversations: { projectRoot: root }, input: invocationFor('planner:project', [], integrationConfig), summarizerProvider: provider, signal: new AbortController().signal });
      const first = readConversation(root, 'planner:project');
      const priorMerged = first.latestCompaction!.groups.find((group) => group.payload.kind === 'merged');
      expect(priorMerged).toBeDefined();
      inputs.length = 0;
      for (let round = 8; round <= 10; round++) appendRawRound(root, round);
      const current = readConversation(root, 'planner:project');
      await compact({ conversations: { projectRoot: root }, input: invocationFor('planner:project', conversationMessagesForModel(current), integrationConfig), summarizerProvider: provider, signal: new AbortController().signal });
      const mergeInputs = inputs.filter((input) => input.sessionId === 'summary:merge').flatMap((input) => input.contextMessages as AgentMessage[]);
      expect(mergeInputs.some((row) => row.content.includes(priorMerged!.payload.summary_text))).toBe(true);
      expect(priorMerged!.payload.content_hash).toBe(hashConversationRows(priorMerged!.sourceRows));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never places a hard-fallback cutoff inside tool or provider-private bundles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-protected-'));
    try {
      const sessionId = 'planner:project';
      const inputId = '00000000-0000-4000-8000-000000000099';
      const timestamp = '2026-07-15T00:01:00.000Z';
      const rows = [
        { id: 'protected-activation', session_id: sessionId, role: 'system' as const, kind: 'activity' as const, content: JSON.stringify({ event: 'activation_open' }), round_id: 'r-pre-99999999999999999999999999999999', message_index: 0, block_index: 0, timestamp },
        { id: 'protected-prefix', session_id: sessionId, role: 'user' as const, kind: 'text' as const, content: 'x'.repeat(600), round_id: 'r-user-99999999999999999999999999999999', message_index: 1, block_index: 0, timestamp },
        { id: `${inputId}:tool-call:call-1`, session_id: sessionId, role: 'assistant' as const, kind: 'tool_call' as const, content: '{}', tool: 'read', tool_call_id: 'call-1', round_id: 'r-assistant-99999999999999999999999999999999', message_index: 2, block_index: 0, timestamp },
        { id: `${inputId}:tool-result:call-1`, session_id: sessionId, role: 'tool' as const, kind: 'tool_result' as const, content: JSON.stringify({ success: true }), tool: 'read', tool_call_id: 'call-1', round_id: 'r-user-99999999999999999999999999999999', message_index: 3, block_index: 0, timestamp },
        { id: 'private-1', session_id: sessionId, role: 'system' as const, kind: 'provider_private' as const, content: 'private', round_id: 'r-user-99999999999999999999999999999999', message_index: 4, block_index: 0, timestamp },
        { id: 'public-1', session_id: sessionId, role: 'assistant' as const, kind: 'text' as const, content: 'y'.repeat(600), round_id: 'r-assistant-99999999999999999999999999999999', message_index: 5, block_index: 0, timestamp, provider_projection: { kind: 'openai_responses' as const, source_input_id: inputId, private_message_id: 'private-1', projection_kind: 'assistant_message' as const } },
        { id: 'protected-tail', session_id: sessionId, role: 'user' as const, kind: 'text' as const, content: 'z'.repeat(600), round_id: 'r-user-99999999999999999999999999999999', message_index: 6, block_index: 0, timestamp },
      ];
      appendConversationBatch(root, rows);
      const result = await compact({ conversations: { projectRoot: root }, input: invocationFor(sessionId, rows, { ...config, input_budget_tokens: 500 }), summarizerProvider: summaryProvider(), signal: new AbortController().signal });
      const validated = readConversation(root, sessionId).latestCompaction!;
      const cutoff = validated.cutoffMessageId;
      expect(cutoff).not.toBe(`${inputId}:tool-call:call-1`);
      expect(cutoff).not.toBe('private-1');
      expect(result.rows.some((row) => row.id === 'protected-tail')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function round(id: string, tokens: number): ClassifiedRound {
  const message = { id: `${id}-m`, session_id: 'planner:project', role: 'user' as const, kind: 'text' as const, content: 'x', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-15T00:00:00.000Z' };
  const positioned = { message, estimated_tokens: tokens };
  return { round_id: id, activation_marker: positioned, rows: [positioned], sub_rounds: [], estimated_tokens: tokens };
}

function appendRawRound(root: string, ordinal: number, session_id = 'planner:project'): void {
  const timestamp = `2026-07-15T00:00:${String(ordinal).padStart(2, '0')}.000Z`;
  appendConversationBatch(root, [{ id: `activation-${ordinal}`, session_id, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}` }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }, { id: `message-${ordinal}`, session_id, role: 'user', kind: 'text', content: `${ordinal}:${'x'.repeat(400)}`, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }]);
}

function invocationFor(sessionId: string, contextMessages: AgentMessage[], compactionConfig: CompactionConfig): LlmInvocationInput & { preparedCompaction: NonNullable<LlmInvocationInput['preparedCompaction']> } {
  const role = sessionId.split(':')[0] as 'planner' | 'executor' | 'reviewer';
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, role, sessionId, systemPrompt: 'system', genericContextMessages: contextMessages, contextMessages, activeConversationReplay: { sessionId, messages: contextMessages }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(compactionConfig, 'system', []), capabilityRequest: {}, episodeContext: {} };
}

function summaryProvider() {
  return { completeTurn: async () => ({ result: { kind: 'message' as const, content: 'short raw-derived summary' }, provider_exchanges: [] }) };
}
