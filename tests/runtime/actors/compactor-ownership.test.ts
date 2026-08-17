import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../../../src/runtime/actors/compaction/compactor.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { preparedInvocationContextFixture } from '../../helpers/prepared-invocation-context.js';
import { durableContentPolicy } from '../../helpers/message-context-policy.js';
import { actorProvider } from '../../helpers/actor-provider.js';
import { executedNoneToolSettlement } from '../../../src/tools/invocation.js';

const compactionConfig: AutonomousCompactionPolicy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' };

describe('ConversationLLMActor compaction ownership', () => {
  it('passes no root/session aliases and sends compact returned projection directly to the provider', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-owner-'));
    initProjectTree(ownerRoot);
    try {
      const projection = [agentMessageSchema.parse({ id: 'projected', session_id: 'agent:planner:project', role: 'system', kind: 'text', content: 'canonical compacted projection', context_policy: durableContentPolicy(), round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' })];
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'agent:planner:project', messages: projection }, compactionMessage: projection[0]!, estimatedProviderMessageTokens: 1 }));
      const compactor: CompactorPort = { shouldCompact: () => true, compact };
      const providerInput = jest.fn(async (_input: PreparedLlmInvocationInput) => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
      const provider: LLMProviderPort = actorProvider(providerInput);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: ownerRoot }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(providerInput) });
      await actor.turn(input(), undefined, terminalHandoff);

      expect(compact).toHaveBeenCalledTimes(1);
      const compactArgs = compact.mock.calls[0]![0];
      expect(Object.keys(compactArgs).sort()).toEqual(['conversations', 'input', 'signal', 'strategy', 'summarizerProvider']);
      expect(compactArgs.strategy).toBe('preventive');
      expect(compactArgs.conversations.projectRoot).toBe(ownerRoot);
      expect(compactArgs.input.sessionId).toBe('agent:planner:project');
      expect(providerInput).toHaveBeenCalledWith(expect.objectContaining({ providerConversation: { sourceSessionId: 'agent:planner:project', messages: projection } }), expect.any(AbortSignal));
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
      const completeTurn = async (value: LlmInvocationInput): Promise<import('../../../src/agents/llm-contracts.js').ProviderTurnCompletion> => {
        providerInputs.push(value);
        if (++calls === 1) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, provider_exchanges: [] };
        return { result: { kind: 'message', content: 'done' }, provider_exchanges: [] };
      };
      const provider: LLMProviderPort = actorProvider(completeTurn);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(completeTurn) });
      const tool = await actor.turn(first, undefined, terminalHandoff);
      if (tool.type !== 'tool_call') throw new Error('Expected tool call.');
      await actor.appendToolResult(tool.toolCallId, executedNoneToolSettlement({ success: true, data: { content: 'x'.repeat(4000) } }));

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.prefix).toBe(checked[0]!.prefix);
      expect(checked[1]!.compiledTools).toBe(checked[0]!.compiledTools);
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
      const completeTurn = async () => ({ result: { kind: 'message' as const, content: ++calls === 1 ? 'plain' : 'repaired' }, provider_exchanges: [] });
      const provider: LLMProviderPort = actorProvider(completeTurn);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(completeTurn) });
      await actor.turn(first, undefined, terminalHandoff);
      await actor.continueAfterPlainText(`repair ${'y'.repeat(4000)}`, undefined, terminalHandoff);

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.prefix).toBe(checked[0]!.prefix);
      expect(checked[1]!.compiledTools).toBe(checked[0]!.compiledTools);
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
      const providerCall = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider: actorProvider(providerCall), conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { candidate:{provider:'test',account:null,model:'test-model'},completeTurn: providerCall, projectProviderExchanges: jest.fn() } });
      const malformed = { ...input(), providerConversation: { sourceSessionId: 'agent:reviewer:project' as const, messages: [] } };

      await expect(actor.turn(malformed, undefined, terminalHandoff)).rejects.toThrow(/does not match provider conversation source session/);
      expect(compact).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
      expect(readConversation(root, 'agent:planner:project').physicalRows).toEqual([]);
      expect(malformed.providerConversation.sourceSessionId).toBe('agent:reviewer:project');
    } finally { consoleError.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a compactor replacement with another source identity before turn-start append or provider use', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-hook-mismatch-'));
    initProjectTree(root);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'agent:reviewer:project', messages: [] }, compactionMessage: agentMessageSchema.parse({ id: 'compaction', session_id: 'agent:reviewer:project', role: 'system', kind: 'text', content: 'x', context_policy: durableContentPolicy(), round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' }), estimatedProviderMessageTokens: 1 }));
      const providerCall = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider: actorProvider(providerCall), conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { candidate:{provider:'test',account:null,model:'test-model'},completeTurn: providerCall, projectProviderExchanges: jest.fn() } });
      await expect(actor.turn(input(), undefined, terminalHandoff)).rejects.toThrow(/Compaction changed provider conversation source session/);
      expect(providerCall).not.toHaveBeenCalled();
      expect(readConversation(root, 'agent:planner:project').physicalRows).toEqual([]);
    } finally { consoleError.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});

const terminalHandoff = (): void => undefined;

function input(): PreparedLlmInvocationInput {
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction(compactionConfig, 'system', []), capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]}, episodeContext: {} };
}

function summarizer(completeTurn: (input: PreparedLlmInvocationInput, signal: AbortSignal) => Promise<import('../../../src/agents/llm-contracts.js').ProviderTurnCompletion>) {
  return { candidate:{provider:'test',account:null,model:'test-model'},completeTurn, projectProviderExchanges: jest.fn() };
}
