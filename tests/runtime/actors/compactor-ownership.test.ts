import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { LLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { CompactionConfig } from '../../../src/runtime/actors/compaction/compactor.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';

const compactionConfig: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };

describe('LLMActor compaction ownership', () => {
  it('passes no root/session aliases and sends compact returned projection directly to the provider', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-owner-'));
    const differentActorRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-decoy-'));
    try {
      const projection = [agentMessageSchema.parse({ id: 'projected', session_id: 'planner:project', role: 'system', kind: 'text', content: 'canonical compacted projection', round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' })];
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ rows: projection }));
      const compactor: CompactorPort = { shouldCompact: () => ({ shouldCompact: true }), compact };
      const providerInput = jest.fn(async (_input: LlmInvocationInput) => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
      const provider: LLMProviderPort = { completeTurn: providerInput };
      const actor = new LLMActor({ projectRoot: differentActorRoot, agentId: 'planner:project', provider, conversations: { projectRoot: ownerRoot }, runtimeProjectionChanged() {}, compactor, compactionConfig, summarizerProvider: provider });
      actor.start();

      await actor.turn(input());

      expect(compact).toHaveBeenCalledTimes(1);
      const compactArgs = compact.mock.calls[0]![0];
      expect(Object.keys(compactArgs).sort()).toEqual(['config', 'conversations', 'input', 'signal', 'summarizerProvider']);
      expect(compactArgs.conversations.projectRoot).toBe(ownerRoot);
      expect(compactArgs.input.sessionId).toBe('planner:project');
      expect(providerInput).toHaveBeenCalledWith(expect.objectContaining({ genericContextMessages: projection, contextMessages: projection }), expect.any(AbortSignal));
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
      rmSync(differentActorRoot, { recursive: true, force: true });
    }
  });
});

function input(): LlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', genericContextMessages: [], contextMessages: [], activeConversationReplay: { sessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 80 }, capabilityRequest: {}, episodeContext: {} };
}
