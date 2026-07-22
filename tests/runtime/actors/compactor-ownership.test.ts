import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../../../src/runtime/actors/compaction/compactor.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { conversationFile } from '../../../src/runtime/actors/conversation-inventory.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const compactionConfig: AutonomousCompactionPolicy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };

describe('ConversationLLMActor compaction ownership', () => {
  it('passes no root/session aliases and sends compact returned projection directly to the provider', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-owner-'));
    initProjectTree(ownerRoot);
    try {
      const projection = [agentMessageSchema.parse({ id: 'projected', session_id: 'planner:project', role: 'system', kind: 'text', content: 'canonical compacted projection', round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' })];
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'planner:project', messages: projection }, compactionMessage: projection[0]!, estimatedProviderMessageTokens: 1 }));
      const compactor: CompactorPort = { shouldCompact: () => true, compact };
      const providerInput = jest.fn(async (_input: PreparedLlmInvocationInput) => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
      const provider: LLMProviderPort = { completeTurn: providerInput };
      const actor = new ConversationLLMActor({ agentId: 'planner:project', provider, conversations: { projectRoot: ownerRoot }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(provider) });
      await actor.turn(input(), undefined, terminalHandoff);

      expect(compact).toHaveBeenCalledTimes(1);
      const compactArgs = compact.mock.calls[0]![0];
      expect(Object.keys(compactArgs).sort()).toEqual(['conversations', 'input', 'signal', 'strategy', 'summarizerProvider']);
      expect(compactArgs.strategy).toBe('preventive');
      expect(compactArgs.conversations.projectRoot).toBe(ownerRoot);
      expect(compactArgs.input.sessionId).toBe('planner:project');
      expect(providerInput).toHaveBeenCalledWith(expect.objectContaining({ providerConversation: { sourceSessionId: 'planner:project', messages: projection } }), expect.any(AbortSignal));
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
    }
  });

  it('preserves prepared compaction through a fresh tool-result continuation and rechecks refreshed context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-tool-continuation-'));
    initProjectTree(root);
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
      const actor = new ConversationLLMActor({ agentId: 'planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(provider) });
      const tool = await actor.turn(first, undefined, terminalHandoff);
      if (tool.type !== 'tool_call') throw new Error('Expected tool call.');
      await actor.appendToolResult(tool.toolCallId, { success: true, data: { content: 'x'.repeat(4000) } });

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.providerConversation.messages.length).toBeGreaterThan(checked[0]!.providerConversation.messages.length);
      expect(providerInputs[1]!.providerConversation).not.toBe(providerInputs[0]!.providerConversation);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves prepared compaction through a fresh plain-text repair and rechecks refreshed context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-plain-repair-'));
    initProjectTree(root);
    try {
      const first = input();
      const prepared = first.preparedCompaction!;
      const checked: LlmInvocationInput[] = [];
      const compactor: CompactorPort = { shouldCompact: (value) => { checked.push(value); return false; }, compact: jest.fn() as never };
      let calls = 0;
      const provider: LLMProviderPort = { completeTurn: async () => ({ result: { kind: 'message', content: ++calls === 1 ? 'plain' : 'repaired' }, provider_exchanges: [] }) };
      const actor = new ConversationLLMActor({ agentId: 'planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(provider) });
      await actor.turn(first, undefined, terminalHandoff);
      await actor.continueAfterPlainText(`repair ${'y'.repeat(4000)}`, undefined, terminalHandoff);

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.providerConversation.messages.length).toBeGreaterThan(checked[0]!.providerConversation.messages.length);
      expect(checked[1]!.providerConversation).not.toBe(checked[0]!.providerConversation);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects invocation/source mismatch before compaction, append, or provider admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-owner-mismatch-'));
    initProjectTree(root);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const compact = jest.fn<CompactorPort['compact']>();
      const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
      const actor = new ConversationLLMActor({ agentId: 'planner:project', provider: { completeTurn: providerCall }, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { completeTurn: providerCall, projectProviderExchanges: jest.fn() } });
      const malformed = { ...input(), providerConversation: { sourceSessionId: 'reviewer:project' as const, messages: [] } };

      await expect(actor.turn(malformed, undefined, terminalHandoff)).rejects.toThrow(/does not match provider conversation source session/);
      expect(compact).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
      expect(existsSync(conversationFile(root, 'planner:project'))).toBe(false);
      expect(malformed.providerConversation.sourceSessionId).toBe('reviewer:project');
    } finally { consoleError.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a compactor replacement with another source identity before turn-start append or provider use', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-hook-mismatch-'));
    initProjectTree(root);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'reviewer:project', messages: [] }, compactionMessage: agentMessageSchema.parse({ id: 'compaction', session_id: 'reviewer:project', role: 'system', kind: 'text', content: 'x', round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' }), estimatedProviderMessageTokens: 1 }));
      const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
      const actor = new ConversationLLMActor({ agentId: 'planner:project', provider: { completeTurn: providerCall }, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { completeTurn: providerCall, projectProviderExchanges: jest.fn() } });
      await expect(actor.turn(input(), undefined, terminalHandoff)).rejects.toThrow(/Compaction changed provider conversation source session/);
      expect(providerCall).not.toHaveBeenCalled();
      expect(existsSync(conversationFile(root, 'planner:project'))).toBe(false);
    } finally { consoleError.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});

const terminalHandoff = (): void => undefined;

function input(): PreparedLlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(compactionConfig, 'system', []), capabilityRequest: {}, episodeContext: {} };
}

function summarizer(provider: LLMProviderPort) {
  return { completeTurn: provider.completeTurn.bind(provider), projectProviderExchanges: jest.fn() };
}
