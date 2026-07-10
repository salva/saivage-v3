import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../../../src/persistence/file-tree.js';
import { appendActivationMarker, appendConversationMessage, conversationMessagesForModel, readActiveVersionMessages } from '../../../../src/runtime/actors/conversation-store.js';
import { readConversationIndex } from '../../../../src/runtime/actors/conversation-index.js';
import { compact, shouldCompact, type BufferSizeEstimator, type CompactionConfig } from '../../../../src/runtime/actors/compaction/compactor.js';
import { summaryCachePath } from '../../../../src/runtime/actors/compaction/summary-cache.js';
import type { LlmInvocationInput } from '../../../../src/runtime/actors/llm-invocation.js';
import type { LLMProviderPort } from '../../../../src/runtime/actors/llm-actor.js';
import type { AgentMessage } from '../../../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-compactor-'));
  initProjectTree(projectRoot);
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

const config: CompactionConfig = {
  enabled: true,
  trigger_fraction: 0.8,
  completion_reserve_fraction: 0,
  merge_line_fraction: 0.3,
  summary_line_fraction: 0.6,
  escalate_merge_line_fraction: 0.5,
  escalate_summary_line_fraction: 0.7,
  snap: 'compact_straddler',
  summarizer_model: 'test/_/summary',
};

const estimator = (bufferTokens: number): BufferSizeEstimator => ({
  estimate(input) {
    const text = input.systemPrompt + JSON.stringify(input.tools) + (input.contextMessages as AgentMessage[]).map((message) => message.content).join('\n');
    return { estimatedTokens: Math.ceil(text.length / 4), bufferTokens };
  },
});

function input(contextMessages: AgentMessage[]): LlmInvocationInput {
  return { inputId: 'planner:project:1', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', contextMessages, tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId: 'project' } };
}

function appendRound(projectRoot: string, ordinal: number, content: string): void {
  appendActivationMarker(projectRoot, 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: `turn-${ordinal}` });
  const timestamp = new Date().toISOString();
  appendConversationMessage(projectRoot, { id: `planner:project:text:${ordinal}`, session_id: 'planner:project', role: 'user', kind: 'text', content, round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp });
}

describe('conversation compactor orchestration', () => {
  it('triggers only at the configured usage fraction', () => {
    const under = input([{ id: 'm1', session_id: 'planner:project', role: 'user', kind: 'text', content: 'x'.repeat(20), round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() }]);
    expect(shouldCompact(under, config, estimator(100)).shouldCompact).toBe(false);
    const over = input([{ ...under.contextMessages[0] as AgentMessage, content: 'x'.repeat(400) }]);
    expect(shouldCompact(over, config, estimator(100)).shouldCompact).toBe(true);
  });

  it('writes a compacted version with user-role summaries, summary_ids, and provider-visible active rows', async () => withTempProject(async (projectRoot) => {
    appendRound(projectRoot, 1, 'old round one ' + 'a'.repeat(80));
    appendRound(projectRoot, 2, 'middle round two ' + 'b'.repeat(80));
    appendRound(projectRoot, 3, 'recent round three ' + 'c'.repeat(80));
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (llmInput: LlmInvocationInput) => ({ result: { kind: 'message' as const, content: `summary:${llmInput.inputId}` }, provider_exchanges: [] })) };

    const { rows } = await compact({ projectRoot, sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), config, summarizerProvider: provider, bufferSizeEstimator: estimator(80) });

    expect(rows.every((row) => row.kind !== 'activity')).toBe(true);
    const summaries = rows.filter((row) => row.kind === 'context_compaction');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((row) => row.role === 'user' && row.round_id.startsWith('r-compacted-'))).toBe(true);
    expect(summaries[0]?.content).toContain('[Compacted prior conversation — generation 1]');
    expect(summaries[0]?.content).toContain('## Recoverable evidence');
    const index = readConversationIndex(projectRoot, 'planner:project');
    expect(index?.active_version).toBe(2);
    expect(index?.versions['2']?.summary_ids?.length).toBeGreaterThan(0);
  }));

  it('re-compacts by replacing prior summary rows and rebuilding merge input from cache', async () => withTempProject(async (projectRoot) => {
    appendRound(projectRoot, 1, 'old round one ' + 'a'.repeat(80));
    appendRound(projectRoot, 2, 'middle round two ' + 'b'.repeat(80));
    appendRound(projectRoot, 3, 'recent round three ' + 'c'.repeat(80));
    const seenInputs: string[] = [];
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (llmInput: LlmInvocationInput) => {
      seenInputs.push((llmInput.contextMessages as AgentMessage[]).map((message) => message.content).join('\n'));
      return { result: { kind: 'message' as const, content: `summary:${llmInput.inputId}` }, provider_exchanges: [] };
    }) };

    await compact({ projectRoot, sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), config, summarizerProvider: provider, bufferSizeEstimator: estimator(80) });
    const firstSummaryContent = readActiveVersionMessages(projectRoot, 'planner:project').filter((row) => row.kind === 'context_compaction').map((row) => row.content).join('\n');
    appendRound(projectRoot, 4, 'new recent round four ' + 'd'.repeat(40));
    await compact({ projectRoot, sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), config, summarizerProvider: provider, bufferSizeEstimator: estimator(130) });
    const active = readActiveVersionMessages(projectRoot, 'planner:project');
    const secondSummaryRows = active.filter((row) => row.kind === 'context_compaction');

    expect(secondSummaryRows.map((row) => row.content)).not.toContain(firstSummaryContent);
    expect(secondSummaryRows.some((row) => row.content.includes('generation 2'))).toBe(true);
    expect(seenInputs.some((content) => content.includes('[Compacted prior conversation'))).toBe(false);
    const cacheKeys = readFileSync(summaryCachePath(projectRoot, 'planner:project'), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line).cache_key as string);
    const summaryIds = readConversationIndex(projectRoot, 'planner:project')?.versions['3']?.summary_ids ?? [];
    expect(summaryIds.length).toBe(new Set(summaryIds).size);
    expect(summaryIds.every((id) => cacheKeys.includes(id))).toBe(true);
  }));
});
