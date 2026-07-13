import { initProjectTree, testCompositionAuthority } from '../../../helpers/canonical-project.js';
import { describe, expect, it, jest } from '@jest/globals';
import { appendTestConversationMessage as appendConversationMessage, testConversationMutations } from '../../../helpers/conversation-mutations.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendActivationMarker, conversationMessagesForModel, readActiveVersionMessages } from '../../../../src/runtime/actors/conversation-store.js';
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
  appendActivationMarker(testConversationMutations(projectRoot), testCompositionAuthority(projectRoot), 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: `turn-${ordinal}` });
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
    const conversations = testConversationMutations(projectRoot);
    const replaceActiveVersion = jest.spyOn(conversations, 'replaceActiveVersion');

    const { rows } = await compact({ projectRoot, conversations, sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), mutationAuthority: testCompositionAuthority(projectRoot), config, summarizerProvider: provider, bufferSizeEstimator: estimator(80), signal: new AbortController().signal });

    expect(replaceActiveVersion).toHaveBeenCalledTimes(1);
    expect(Object.keys(replaceActiveVersion.mock.calls[0]![1])).toEqual(['sessionId', 'sourceVersion', 'sourceDigest', 'content', 'compactedThrough', 'summaryIds', 'compactionGeneration', 'bands']);
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

    await compact({ projectRoot, conversations: testConversationMutations(projectRoot), sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), mutationAuthority: testCompositionAuthority(projectRoot), config, summarizerProvider: provider, bufferSizeEstimator: estimator(80), signal: new AbortController().signal });
    const firstSummaryContent = readActiveVersionMessages(projectRoot, 'planner:project').filter((row) => row.kind === 'context_compaction').map((row) => row.content).join('\n');
    appendRound(projectRoot, 4, 'new recent round four ' + 'd'.repeat(40));
    await compact({ projectRoot, conversations: testConversationMutations(projectRoot), sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), mutationAuthority: testCompositionAuthority(projectRoot), config, summarizerProvider: provider, bufferSizeEstimator: estimator(130), signal: new AbortController().signal });
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

  it('preserves paired OpenAI Responses private rows in the active compacted version while returning provider-visible rows only', async () => withTempProject(async (projectRoot) => {
    appendRound(projectRoot, 1, 'old round one ' + 'a'.repeat(80));
    appendRound(projectRoot, 2, 'middle round two ' + 'b'.repeat(80));
    appendRound(projectRoot, 3, 'recent round three ' + 'c'.repeat(80));
    const timestamp = new Date().toISOString();
    const privateId = 'responses-input:provider-private:openai-responses';
    const visibleId = 'responses-input:message';
    appendConversationMessage(projectRoot, { id: privateId, session_id: 'planner:project', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: 'responses-input', projection_message_id: visibleId, provider: 'openai', model: 'gpt-5.6', output: [{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'message', content: [{ type: 'output_text', text: 'visible' }] }] }), round_id: 'r-assistant-00000000000000000000000000000003', message_index: 1, block_index: 0, timestamp });
    appendConversationMessage(projectRoot, { id: visibleId, session_id: 'planner:project', role: 'assistant', kind: 'text', content: 'visible', round_id: 'r-assistant-00000000000000000000000000000003', message_index: 1, block_index: 1, timestamp, provider_projection: { kind: 'openai_responses', source_input_id: 'responses-input', private_message_id: privateId, projection_kind: 'assistant_message' } });
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (llmInput: LlmInvocationInput) => ({ result: { kind: 'message' as const, content: `summary:${llmInput.inputId}` }, provider_exchanges: [] })) };

    const { rows } = await compact({ projectRoot, conversations: testConversationMutations(projectRoot), sessionId: 'planner:project', input: input(conversationMessagesForModel(readActiveVersionMessages(projectRoot, 'planner:project'))), mutationAuthority: testCompositionAuthority(projectRoot), config, summarizerProvider: provider, bufferSizeEstimator: estimator(80), signal: new AbortController().signal });
    const active = readActiveVersionMessages(projectRoot, 'planner:project');

    expect(rows.some((row) => row.kind === 'provider_private')).toBe(false);
    expect(active).toEqual(expect.arrayContaining([expect.objectContaining({ id: privateId, kind: 'provider_private' }), expect.objectContaining({ id: visibleId, provider_projection: expect.objectContaining({ private_message_id: privateId }) })]));
  }));
});
