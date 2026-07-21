import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { conversationFile } from '../../../src/runtime/actors/conversation-inventory.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import {
  compact,
  CompactionAppendError,
  CompactionSummaryConstructionError,
  prepareCompaction,
  type AutonomousCompactionPolicy,
} from '../../../src/runtime/actors/compaction/compactor.js';
import { type SummarizerProviderPort } from '../../../src/runtime/actors/compaction/summarizer.js';
import { AppLogPublicationError } from '../../../src/persistence/app-log.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { AgentMessage } from '../../../src/schemas/index.js';
import { estimateMessageTokens } from '../../../src/runtime/actors/compaction/round-classifier.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const config: AutonomousCompactionPolicy = { input_budget_tokens: 400, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };

describe('authoritative context-recovery compaction', () => {
  it('starts at escalated, appends once only for a strictly smaller valid projection, and preserves source rows', async () => {
    const root = projectWithRounds(5);
    const before = readConversation(root, 'planner:project');
    const rejected = providerConversationProjection(before);
    const args = compactArgs(root, rejected, summaryProvider());
    const result = await compact(args);

    expect(result.kind).toBe('compacted');
    if (result.kind !== 'compacted') return;
    expect(result.estimatedProviderMessageTokens).toBeLessThan(rejected.messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0));
    expect(JSON.parse(result.compactionMessage.content).applied_policy).toMatchObject({ mode: 'escalated', band: 'escalated' });
    const after = readConversation(root, 'planner:project');
    expect(after.sourceRows).toEqual(before.sourceRows);
    expect(after.compactions).toHaveLength(1);
    expect(result.providerConversation).toEqual(providerConversationProjection(after));
  });

  it('advances from non-reducing escalated output through safe hard fallback', async () => {
    const root = projectWithOversizedOpenRound();
    const before = readConversation(root, 'planner:project');
    const result = await compact(compactArgs(root, providerConversationProjection(before), summaryProvider('small')));

    expect(result.kind).toBe('compacted');
    if (result.kind !== 'compacted') return;
    expect(JSON.parse(result.compactionMessage.content).applied_policy.mode).toBe('hard_limit_fallback');
    expect(readConversation(root, 'planner:project').latestCompaction!.cutoffMessageId).not.toBe('open-message-9');
  });

  it('returns clean no_smaller_projection without append when no safe smaller candidate exists', async () => {
    const root = projectWithSingleSourceRow();
    const rejected = providerConversationProjection(readConversation(root, 'planner:project'));
    const provider = summaryProvider();
    const result = await compact(compactArgs(root, rejected, provider));

    expect(result.kind).toBe('no_smaller_projection');
    if (result.kind !== 'no_smaller_projection') return;
    expect(result.rejectedEstimatedProviderMessageTokens).toBe(rejected.messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0));
    expect(result.smallestCandidateEstimatedProviderMessageTokens).not.toBeNull();
    expect(result.smallestCandidateEstimatedProviderMessageTokens!).toBeGreaterThanOrEqual(result.rejectedEstimatedProviderMessageTokens);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(0);
    expect(provider.completeTurn).toHaveBeenCalled();
  });

  it('reports a null smallest candidate when no safe candidate can be constructed', async () => {
    const root = tempRoot();
    const provider = summaryProvider();
    const result = await compact(compactArgs(root, { sourceSessionId: 'planner:project', messages: [] }, provider));

    expect(result).toEqual({ kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 0, smallestCandidateEstimatedProviderMessageTokens: null });
    expect(readConversation(root, 'planner:project').physicalRows).toEqual([]);
    expect(provider.completeTurn).not.toHaveBeenCalled();
  });

  it('wraps summary construction failure only, with no compaction append', async () => {
    const root = projectWithRounds(5);
    const cause = new Error('summary provider failed');
    const provider = summaryProvider();
    provider.completeTurn.mockImplementation(async () => { throw cause; });

    await expect(compact(compactArgs(root, providerConversationProjection(readConversation(root, 'planner:project')), provider))).rejects.toMatchObject({
      name: 'CompactionSummaryConstructionError',
      cause,
    } satisfies Partial<CompactionSummaryConstructionError>);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(0);
  });

  it('propagates summarizer projection uncertainty without construction wrapping or append', async () => {
    const root = projectWithRounds(5);
    const projectionCause = new AppLogPublicationError('provider_exchange', new Error('projection publication unknown'));
    const provider = summaryProvider();
    provider.projectProviderExchanges = jest.fn(() => { throw projectionCause; });

    const failure = await compact(compactArgs(root, providerConversationProjection(readConversation(root, 'planner:project')), provider)).catch((error: unknown) => error);
    expect(failure).toBe(projectionCause);
    expect(failure).not.toBeInstanceOf(CompactionSummaryConstructionError);
    expect(provider.projectProviderExchanges).toHaveBeenCalledTimes(1);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(0);
  });

  it('rethrows the exact cancellation reason before append', async () => {
    const root = projectWithRounds(5);
    const controller = new AbortController();
    const reason = new Error('cancel compaction');
    const provider = summaryProvider();
    provider.completeTurn.mockImplementation(async () => { controller.abort(reason); throw reason; });

    await expect(compact({ ...compactArgs(root, providerConversationProjection(readConversation(root, 'planner:project')), provider), signal: controller.signal })).rejects.toBe(reason);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(0);
  });

  it('leaves an appended canonical row valid when cancellation arrives at the append boundary', async () => {
    const root = projectWithRounds(5);
    const controller = new AbortController();
    const reason = new Error('cancel after append');
    const args = compactArgs(root, providerConversationProjection(readConversation(root, 'planner:project')), summaryProvider());
    const result = await compact({ ...args, signal: controller.signal, conversations: { projectRoot: root, changes: { conversationChanged: () => controller.abort(reason), agentsChanged() {} } } });

    expect(result.kind).toBe('compacted');
    expect(controller.signal.reason).toBe(reason);
    expect(readConversation(root, 'planner:project').compactions).toHaveLength(1);
  });

  it('propagates canonical source validation failure raw before summary or append', async () => {
    const root = projectWithRounds(2);
    appendFileSync(conversationFile(root, 'planner:project'), '{"kind":"conversation_rows","version":1,"rows":[{"malformed":true}]}\n');
    const provider = summaryProvider();

    const failure = await compact(compactArgs(root, { sourceSessionId: 'planner:project', messages: [] }, provider)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CompactionSummaryConstructionError);
    expect(failure).not.toBeInstanceOf(CompactionAppendError);
    expect(provider.completeTurn).not.toHaveBeenCalled();
  });
});

function compactArgs(root: string, providerConversation: LlmInvocationInput['providerConversation'], summarizerProvider: SummarizerProviderPort) {
  return { strategy: 'authoritative_context_recovery' as const, conversations: { projectRoot: root }, input: invocation(providerConversation), summarizerProvider, signal: new AbortController().signal };
}

function invocation(providerConversation: LlmInvocationInput['providerConversation']): PreparedLlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(config, 'system', []), capabilityRequest: {}, episodeContext: {} };
}

function summaryProvider(content = 'summary') {
  return { completeTurn: jest.fn(async () => ({ result: { kind: 'message' as const, content }, provider_exchanges: [] })), projectProviderExchanges: jest.fn() } satisfies SummarizerProviderPort;
}

function projectWithRounds(count: number): string {
  const root = tempRoot();
  for (let ordinal = 0; ordinal < count; ordinal += 1) appendConversationBatch({ projectRoot: root }, roundRows(ordinal));
  return root;
}

function projectWithSingleSourceRow(): string {
  const root = tempRoot();
  appendConversationBatch({ projectRoot: root }, roundRows(0, 1));
  return root;
}

function projectWithOversizedOpenRound(): string {
  const root = tempRoot();
  const timestamp = '2026-07-17T00:00:00.000Z';
  appendConversationBatch({ projectRoot: root }, [
    message('open-activation', 'system', 'activity', activationContent(99, timestamp), 0, timestamp),
    ...Array.from({ length: 10 }, (_, index) => message(`open-message-${index}`, 'user', 'text', `${index}:${'x'.repeat(320)}`, index + 1, timestamp)),
  ]);
  return root;
}

function roundRows(ordinal: number, contentLength = 400): AgentMessage[] {
  const timestamp = `2026-07-17T00:00:${String(ordinal).padStart(2, '0')}.000Z`;
  return [
    message(`activation-${ordinal}`, 'system', 'activity', activationContent(ordinal, timestamp), 0, timestamp),
    message(`message-${ordinal}`, 'user', 'text', `${ordinal}:${'x'.repeat(contentLength)}`, 1, timestamp),
  ];
}

function activationContent(ordinal: number, timestamp: string): string {
  return JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, '0')}`, timestamp });
}

function message(id: string, role: AgentMessage['role'], kind: AgentMessage['kind'], content: string, messageIndex: number, timestamp: string): AgentMessage {
  return { id, session_id: 'planner:project', role, kind, content, round_id: 'r-user-00000000000000000000000000000000', message_index: messageIndex, block_index: 0, timestamp };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-authoritative-compactor-'));
  initProjectTree(root);
  roots.push(root);
  return root;
}
