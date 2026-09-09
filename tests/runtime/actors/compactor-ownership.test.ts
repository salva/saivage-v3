import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

import { ConversationLLMActor, type CompactorPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { prepareCompaction, type AutonomousCompactionPolicy } from '../../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../../src/runtime/actors/context/context-blocks.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { scriptedAdmissionProvider } from '../../helpers/llm-test-helpers.js';
import type { ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { toolSucceeded } from '../../../src/contracts/tool-result.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/index.js';
import type { SummarizerProviderPort } from '../../../src/runtime/actors/compaction/summarizer.js';

const compactionConfig: AutonomousCompactionPolicy = { input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, tail_fraction: 0.25, snap: 'compact_straddler' };

describe('ConversationLLMActor compaction ownership', () => {
  it('passes no root/session aliases and sends compact returned projection directly to the provider', async () => {
    const ownerRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-owner-'));
    initProjectTree(ownerRoot);
    try {
      const projection = [agentMessageSchema.parse({ id: 'projected', session_id: 'agent:planner:project', role: 'system', kind: 'text', content: 'canonical compacted projection', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }, round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' })];
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'agent:planner:project', messages: projection }, compactionMessage: projection[0]!, estimatedProviderMessageTokens: 1 }));
      const compactor: CompactorPort = { shouldCompact: () => true, compact };
      const providerInput = jest.fn(async (_input: PreparedLlmInvocationInput): Promise<ProviderTurnCompletion> => ({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] }));
      const provider = scriptedAdmissionProvider<PreparedLlmInvocationInput>(providerInput);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: ownerRoot }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(providerInput) });
      await actor.turn(input(), undefined, terminalHandoff);

      expect(compact).toHaveBeenCalledTimes(1);
      const compactArgs = compact.mock.calls[0]![0];
      expect(Object.keys(compactArgs).sort()).toEqual(['conversations', 'input', 'progress', 'signal', 'strategy', 'summarizerProvider']);
      expect(compactArgs.strategy).toBe('preventive');
      expect(compactArgs.conversations.projectRoot).toBe(ownerRoot);
      expect(compactArgs.input.sessionId).toBe('agent:planner:project');
      expect(providerInput).toHaveBeenCalledWith(expect.objectContaining({ providerConversation: { sourceSessionId: 'agent:planner:project', messages: projection } }), expect.any(AbortSignal));
    } finally {
      rmSync(ownerRoot, { recursive: true, force: true });
    }
  });

  it('publishes actor-owned logical fold progress and clears it after ordinary completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-progress-'));
    initProjectTree(root);
    try {
      let captureArgs!: (args: Parameters<CompactorPort['compact']>[0]) => void;
      const capturedArgs = new Promise<Parameters<CompactorPort['compact']>[0]>((resolve) => { captureArgs = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const compactor: CompactorPort = {
        shouldCompact: () => true,
        compact: jest.fn<CompactorPort['compact']>(async (args) => {
          captureArgs(args);
          await held;
          return { kind: 'compacted', providerConversation: args.input.providerConversation, estimatedProviderMessageTokens: 0 };
        }),
      };
      const changes = jest.fn();
      const provider = scriptedAdmissionProvider(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged: changes, compactor, summarizerProvider: summarizer(async () => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] })) });
      const turn = actor.turn(input(), undefined, terminalHandoff);
      const compactArgs = await capturedArgs;
      expect(actor.compactionProgress()).toEqual(expect.objectContaining({ strategy: 'preventive', foldsDone: 0, foldInFlight: false }));
      compactArgs.progress.foldStarted();
      expect(actor.compactionProgress()).toEqual(expect.objectContaining({ foldsDone: 0, foldInFlight: true }));
      compactArgs.progress.foldCompleted();
      expect(actor.compactionProgress()).toEqual(expect.objectContaining({ foldsDone: 1, foldInFlight: false }));
      release();
      await turn;
      expect(actor.compactionProgress()).toBeNull();
      expect(changes).toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('delivers publication uncertainty before any progress clear or later hint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-progress-fatal-'));
    initProjectTree(root);
    const delivered = new Error('fatal delivered');
    try {
      const changes = jest.fn();
      const compactor: CompactorPort = { shouldCompact: () => true, compact: jest.fn<CompactorPort['compact']>(async (args) => { args.progress.foldStarted(); throw new PublicationOutcomeUnknownError(); }) };
      const provider = scriptedAdmissionProvider(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: { publicationOutcomeUnknown(): never { throw delivered; } }, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged: changes, compactor, summarizerProvider: summarizer(async () => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] })) });
      await expect(actor.turn(input(), undefined, terminalHandoff)).rejects.toBe(delivered);
      expect(actor.compactionProgress()).toEqual(expect.objectContaining({ foldsDone: 0, foldInFlight: true }));
      expect(changes).toHaveBeenCalledTimes(3); // arming, compaction start, fold start
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('clears only current progress on ordinary compaction failure and disposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-progress-clear-'));
    initProjectTree(root);
    try {
      const provider = scriptedAdmissionProvider(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
      const failed = new Error('summary failed');
      const failingActor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact: async (args) => { args.progress.foldStarted(); throw failed; } }, summarizerProvider: summarizer(async () => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] })) });
      await expect(failingActor.turn(input(), undefined, terminalHandoff)).rejects.toBe(failed);
      expect(failingActor.compactionProgress()).toBeNull();

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const disposedActor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact: async (args) => { args.progress.foldStarted(); markStarted(); await held; return { kind: 'compacted', providerConversation: args.input.providerConversation, estimatedProviderMessageTokens: 0 }; } }, summarizerProvider: summarizer(async () => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] })) });
      const turn = disposedActor.turn(input(), undefined, terminalHandoff);
      await started;
      expect(disposedActor.compactionProgress()?.foldInFlight).toBe(true);
      const reason = new Error('disposed');
      disposedActor.dispose(reason);
      expect(disposedActor.compactionProgress()).toBeNull();
      release();
      await expect(turn).rejects.toBe(reason);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
      const providerScript = async (value: LlmInvocationInput) => {
        providerInputs.push(value);
        if (++calls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }, provider_exchanges: [] };
        return { result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] };
      };
      const provider = scriptedAdmissionProvider(providerScript);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(providerScript) });
      const tool = await actor.turn(first, undefined, terminalHandoff);
      if (tool.type !== 'tool_call') throw new Error('Expected tool call.');
      await actor.appendToolResult(tool.toolCallId, { kind: 'executed', execution: { providerOutcome: toolSucceeded({ content: 'x'.repeat(4000) }), evidence: { kind: 'none' } } });

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.preparedContext).toBe(first.preparedContext);
      expect(checked[1]!.preparedContext!.prefix.immutablePrefixSha256).toBe(checked[0]!.preparedContext!.prefix.immutablePrefixSha256);
      expect(checked[1]!.preparedContext!.internalToolContractSha256).toBe(checked[0]!.preparedContext!.internalToolContractSha256);
      expect(checked[1]!.preparedContext!.dynamicBlocksSha256).toBe(checked[0]!.preparedContext!.dynamicBlocksSha256);
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
      const providerScript = async () => ({ result: { kind: 'message' as const, content: ++calls === 1 ? 'plain' : 'repaired' }, provider_exchanges: [] });
      const provider = scriptedAdmissionProvider(providerScript);
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider, conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor, summarizerProvider: summarizer(providerScript) });
      await actor.turn(first, undefined, terminalHandoff);
      await actor.continueAfterPlainText(`repair ${'y'.repeat(4000)}`, undefined, terminalHandoff);

      expect(checked).toHaveLength(2);
      expect(checked[0]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.preparedCompaction).toBe(prepared);
      expect(checked[1]!.systemPrompt).toBe(checked[0]!.systemPrompt);
      expect(checked[1]!.tools).toBe(checked[0]!.tools);
      expect(checked[1]!.inputId).not.toBe(checked[0]!.inputId);
      expect(checked[1]!.preparedContext).toBe(first.preparedContext);
      expect(checked[1]!.preparedContext!.prefix.immutablePrefixSha256).toBe(checked[0]!.preparedContext!.prefix.immutablePrefixSha256);
      expect(checked[1]!.preparedContext!.internalToolContractSha256).toBe(checked[0]!.preparedContext!.internalToolContractSha256);
      expect(checked[1]!.preparedContext!.dynamicBlocksSha256).toBe(checked[0]!.preparedContext!.dynamicBlocksSha256);
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
      const providerCall = jest.fn(async (_input: LlmInvocationInput, _signal: AbortSignal) => new Promise<never>(() => undefined));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider: scriptedAdmissionProvider(providerCall), conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest: () => { throw new Error('Unexpected summarizer request serialization in test.'); }, completeTurn: (input, _admitted, signal) => providerCall(input, signal), projectProviderExchanges: jest.fn() } });
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
      const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted', providerConversation: { sourceSessionId: 'agent:reviewer:project', messages: [] }, compactionMessage: agentMessageSchema.parse({ id: 'compaction', session_id: 'agent:reviewer:project', role: 'system', kind: 'text', content: 'x', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }, round_id: 'r-compacted-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-16T00:00:00.000Z' }), estimatedProviderMessageTokens: 1 }));
      const providerCall = jest.fn(async (_input: LlmInvocationInput, _signal: AbortSignal) => new Promise<never>(() => undefined));
      const actor = new ConversationLLMActor({ purpose:{kind:'autonomous-card',cardId:'project'},gate:new RuntimeGate(),fatalPort: testApplicationFatalPort, agentId: 'agent:planner:project', provider: scriptedAdmissionProvider(providerCall), conversations: { projectRoot: root }, runtimeProjectionChanged() {}, compactor: { shouldCompact: () => true, compact }, summarizerProvider: { candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest: () => { throw new Error('Unexpected summarizer request serialization in test.'); }, completeTurn: (input, _admitted, signal) => providerCall(input, signal), projectProviderExchanges: jest.fn() } });
      await expect(actor.turn(input(), undefined, terminalHandoff)).rejects.toThrow(/Compaction changed provider conversation source session/);
      expect(providerCall).not.toHaveBeenCalled();
      expect(readConversation(root, 'agent:planner:project').physicalRows).toEqual([]);
    } finally { consoleError.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});

const terminalHandoff = (): void => undefined;

function input(): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction(compactionConfig, 'system', []);
  return { inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]}, episodeContext: {} };
}

function summarizer(completeTurn: SummarizerProviderPort['completeTurn']): SummarizerProviderPort {
  return { candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest: () => { throw new Error('Unexpected summarizer request serialization in test.'); }, completeTurn, projectProviderExchanges: jest.fn() };
}
