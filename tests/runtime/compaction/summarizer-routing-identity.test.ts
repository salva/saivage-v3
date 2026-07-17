import { describe, expect, it, jest } from '@jest/globals';

import { summarizeMerge, summarizeRound } from '../../../src/runtime/actors/compaction/summarizer.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';

describe('summarizer input identity boundary', () => {
  it('keeps prompts and episode context identity-free', async () => {
    let captured!: LlmInvocationInput;
    const completeTurn = jest.fn(async (input: LlmInvocationInput) => {
      captured = input;
      return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
    });
    const row = agentMessageSchema.parse({ id: 'source', session_id: 'planner:project', role: 'user', kind: 'text', content: 'work', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' });

    await summarizeRound({ sourceSessionId: 'planner:project', round_id: row.round_id, rows: [row], summarizerProvider: { completeTurn, projectProviderExchanges: jest.fn() }, signal: new AbortController().signal });

    expect(captured.systemPrompt).not.toContain('Model:');
    expect(captured.episodeContext).toEqual({ compaction: true });
    expect(captured.episodeContext).not.toHaveProperty('model_spec');
    expect(captured).not.toHaveProperty('preparedCompaction');
  });

  it('renders merge summaries directly without canonical messages', async () => {
    let captured!: LlmInvocationInput;
    await summarizeMerge({
      entries: [{ round_id: 'one', summary_text: 'first' }, { round_id: 'two', summary_text: 'second' }],
      summarizerProvider: {
        completeTurn: jest.fn(async (input: LlmInvocationInput) => { captured = input; return { result: { kind: 'message' as const, content: 'merged' }, provider_exchanges: [] }; }),
        projectProviderExchanges: jest.fn(),
      },
      signal: new AbortController().signal,
    });
    expect(captured.sessionId).toBe('summary:merge');
    expect(captured.providerConversation.messages).toEqual([]);
    expect(captured.systemPrompt).toContain('Round one:\nfirst');
    expect(captured.systemPrompt).toContain('Round two:\nsecond');
  });
});
