import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { LLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { prepareCompaction, type CompactionConfig } from '../../../src/runtime/actors/compaction/compactor.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';

const compactionConfig: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };

describe('LLMActor compaction ownership', () => {
  it('passes no root/session aliases and sends compact returned projection directly to the provider', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-owner-'));
    const differentActorRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-decoy-'));
    try {
      const projection = [agentMessageSchema.parse({ id: 'projected', session_id: 'planner:project', role: 'system', kind: 'text', content: 'canonical compacted projection', round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' })];
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ rows: projection }));
      const compactor: CompactorPort = { shouldCompact: () => true, compact };
      const providerInput = jest.fn(async (_input: LlmInvocationInput) => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
      const provider: LLMProviderPort = { completeTurn: providerInput };
      const actor = new LLMActor({ projectRoot: differentActorRoot, agentId: 'planner:project', provider, conversations: { projectRoot: ownerRoot }, runtimeProjectionChanged() {}, compactor, summarizerProvider: provider });
      actor.start();

      await actor.turn(input());

      expect(compact).toHaveBeenCalledTimes(1);
      const compactArgs = compact.mock.calls[0]![0];
      expect(Object.keys(compactArgs).sort()).toEqual(['conversations', 'input', 'signal', 'summarizerProvider']);
      expect(compactArgs.conversations.projectRoot).toBe(ownerRoot);
      expect(compactArgs.input.sessionId).toBe('planner:project');
      expect(providerInput).toHaveBeenCalledWith(expect.objectContaining({ genericContextMessages: projection, contextMessages: projection }), expect.any(AbortSignal));
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
      rmSync(differentActorRoot, { recursive: true, force: true });
    }
  });

  it('preserves prepared compaction through a fresh tool-result continuation and rechecks refreshed context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-tool-continuation-'));
    try {
      const first = input();
      const prepared = first.preparedCompaction!;
      const checked: LlmInvocationInput[] = [];
      const compactor: CompactorPort = { shouldCompact: (value) => { checked.push(value); return false; }, compact: jest.fn() as never };
      let calls = 0;
      const providerInputs: LlmInvocationInput[] = [];
      const provider: LLMProviderPort = { completeTurn: async (value) => {
        providerInputs.push(value);
        if (++calls === 1) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, provider_exchanges: [] };
        return { result: { kind: 'message', content: 'done' }, provider_exchanges: [] };
      } };
      const actor = new LLMActor({ projectRoot: root, agentId: 'planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: provider });
      actor.start();
      const tool = await actor.turn(first);
      if (tool.type !== 'tool_call') throw new Error('Expected tool call.');
      await actor.appendToolResult(tool.toolCallId, { success: true, data: { content: 'x'.repeat(4000) } });

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.contextMessages.length).toBeGreaterThan(checked[0]!.contextMessages.length);
      expect(providerInputs[1]!.activeConversationReplay).not.toBe(providerInputs[0]!.activeConversationReplay);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves prepared compaction through a fresh plain-text repair and rechecks refreshed context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-plain-repair-'));
    try {
      const first = input();
      const prepared = first.preparedCompaction!;
      const checked: LlmInvocationInput[] = [];
      const compactor: CompactorPort = { shouldCompact: (value) => { checked.push(value); return false; }, compact: jest.fn() as never };
      let calls = 0;
      const provider: LLMProviderPort = { completeTurn: async () => ({ result: { kind: 'message', content: ++calls === 1 ? 'plain' : 'repaired' }, provider_exchanges: [] }) };
      const actor = new LLMActor({ projectRoot: root, agentId: 'planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: provider });
      actor.start();
      await actor.turn(first);
      await actor.continueAfterPlainText(`repair ${'y'.repeat(4000)}`);

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.contextMessages.length).toBeGreaterThan(checked[0]!.contextMessages.length);
      expect(checked[1]!.activeConversationReplay).not.toBe(checked[0]!.activeConversationReplay);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function input(): LlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', genericContextMessages: [], contextMessages: [], activeConversationReplay: { sessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(compactionConfig, 'system', []), capabilityRequest: {}, episodeContext: {} };
}
