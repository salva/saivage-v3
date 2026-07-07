import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { actorKindFromId, appendActivationMarker, appendUserContextMessage, BaseMainLLMCardProcessorActor, conversationIndexPath, LLMActor, parseLlmActorId, readActorSnapshots, readConversationMessages, type LLMActorOutcome, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import { activeVersionPath } from '../../../src/runtime/actors/conversation-index.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import type { InvocationSurface } from '../../../src/tools/invocation.js';
import type { CompactionConfig } from '../../../src/runtime/actors/compaction/compactor.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-actor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function input(inputId = 'turn-1'): LlmInvocationInput {
  return {
    inputId,
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt: 'system',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: {},
    episodeContext: { cardId: 'project' },
  };
}

function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function corruptActorMessages(projectRoot: string): void {
  const indexPath = conversationIndexPath(projectRoot, 'planner:project');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ schema_version: 1, active_segment: 'seg-001.jsonl' }) + '\n', 'utf-8');
  const path = join(dirname(indexPath), 'seg-001.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"partial"', 'utf-8');
}

class InitialOutcomeHarness extends BaseMainLLMCardProcessorActor {
  constructor(projectRoot: string, provider: LLMProviderPort) {
    super({ projectRoot, cardId: 'project', provider });
  }

  resolveForTest(llm: LLMActor, buildInput: () => LlmInvocationInput, isTerminalToolName = () => false): Promise<LLMActorOutcome> {
    return this.resolveInitialOutcome(llm, buildInput, {} as InvocationSurface, isTerminalToolName, new AbortController().signal);
  }

  protected recoverableLlmAgentIds(): readonly string[] { return []; }
  protected get processorLabel(): string { return 'Harness processor'; }
  protected get processorKind(): 'planning' { return 'planning'; }
  protected activationFailureOutcome(error: string) { return { status: 'failed' as const, summary: error, result: { kind: 'failed' as const, summary: error } }; }
}

async function eventually(assertion: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 0)); }
  }
  throw lastError;
}

describe('LLMActor', () => {
  it('defines only live LLM turn states and transitions', () => {
    expect(LLMActor._actor.states).toEqual({
      idle: { parked: true, on: { turn: 'calling_provider' } },
      calling_provider: { on: { done: 'idle', failed: 'idle', tool_call: 'waiting_tool' } },
      waiting_tool: { parked: true, on: { turn: 'calling_provider', abandon: 'idle' } },
    });
  });

  it('persists invocation context before provider call and records message results', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let sawStartedMessage = false;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        sawStartedMessage = jsonl(activeVersionPath(projectRoot, 'planner:project', 1)).some((entry) => String(entry.id).endsWith(':started'));
        return { kind: 'message' as const, content: 'done' };
      }),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const outcome = await actor.turn(input());

    expect(sawStartedMessage).toBe(true);
    expect(outcome).toMatchObject({ type: 'result', result: { content: 'done' } });
    await eventually(() => expect(actor.state()).toBe('idle'));
    expect(jsonl(activeVersionPath(projectRoot, 'planner:project', 1)).map((entry) => entry.kind)).toEqual(['system_prompt', 'activity', 'text']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toContain('planner:project');
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'planner:project')?.context.active_reconstruction).toBeNull();
  }));

  it('runs compaction only from the base pre-provider hook and swaps context wholesale', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const compacted = { id: 'planner:project:compacted', session_id: 'planner:project', role: 'user' as const, kind: 'context_compaction' as const, content: '[Compacted prior conversation — generation 1]:\nsummary\n\n## Recoverable evidence (use `read` to recover full content)\nNone.', round_id: 'r-compacted-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() };
    const config = { enabled: true, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim', summarizer_model: 'test/_/summary' } satisfies CompactionConfig;
    const compactor = {
      shouldCompact: jest.fn(() => ({ shouldCompact: true })),
      compact: jest.fn(async () => [compacted]),
    };
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (providerInput: LlmInvocationInput) => ({ kind: 'message' as const, content: `saw:${(providerInput.contextMessages as unknown[]).length}:${(providerInput.contextMessages[0] as { content: string }).content}` })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider, compactor, compactionConfig: config, summarizerProvider: provider, bufferSizeEstimator: { estimate: () => ({ estimatedTokens: 100, bufferTokens: 100 }) } });
    actor.start();

    const outcome = await actor.turn({ ...input(), contextMessages: [{ ...compacted, id: 'raw', kind: 'text', content: 'raw context before compaction', round_id: 'r-user-00000000000000000000000000000001' }] });

    expect(compactor.shouldCompact).toHaveBeenCalledTimes(1);
    expect(compactor.compact).toHaveBeenCalledTimes(1);
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ contextMessages: [compacted] }), expect.any(AbortSignal));
    expect(outcome).toMatchObject({ type: 'result', result: { content: expect.stringContaining('saw:1:[Compacted prior conversation') } });
  }));

  it('does not set compacting when shouldCompact is false', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const config = { enabled: true, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim', summarizer_model: 'test/_/summary' } satisfies CompactionConfig;
    const compactor = { shouldCompact: jest.fn(() => ({ shouldCompact: false })), compact: jest.fn(async () => []) };
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'done' })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider, compactor, compactionConfig: config, summarizerProvider: provider, bufferSizeEstimator: { estimate: () => ({ estimatedTokens: 1, bufferTokens: 100 }) } });
    actor.start();

    await actor.turn(input());

    expect(compactor.compact).not.toHaveBeenCalled();
    expect(readActorSnapshots(projectRoot).some((snapshot) => snapshot.context.compacting === true)).toBe(false);
  }));

  it('invokes the initial input factory only on the idle branch', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let finishCalling!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finishCalling = () => resolve({ kind: 'message' as const, content: 'done' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();
    const pendingTurn = actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('calling_provider'));
    const harness = new InitialOutcomeHarness(projectRoot, provider);
    const factory = jest.fn(() => {
      appendActivationMarker(projectRoot, 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: 'lazy-input' });
      appendUserContextMessage(projectRoot, 'planner:project', 'lazy-input', 'planner_state', 0, 'lazy planner state');
      return input('lazy-input');
    });

    const recovered = harness.resolveForTest(actor, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(readConversationMessages(projectRoot, 'planner:project').some((message) => message.content === 'lazy planner state')).toBe(false);
    await eventually(() => expect(typeof finishCalling).toBe('function'));
    finishCalling();
    await expect(recovered).resolves.toMatchObject({ type: 'result' });
    await expect(pendingTurn).resolves.toMatchObject({ type: 'result' });
    expect(factory).not.toHaveBeenCalled();
  }));

  it('does not invoke the initial input factory on the waiting-tool branch', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();
    await actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('waiting_tool'));
    const harness = new InitialOutcomeHarness(projectRoot, provider);
    const factory = jest.fn(() => input('lazy-input'));

    await expect(harness.resolveForTest(actor, factory, () => true)).resolves.toMatchObject({ type: 'tool_call', toolCallId: 'call-1' });

    expect(factory).not.toHaveBeenCalled();
  }));

  it('invokes the initial input factory on the idle branch', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'done' })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();
    const harness = new InitialOutcomeHarness(projectRoot, provider);
    const factory = jest.fn(() => {
      appendActivationMarker(projectRoot, 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: 'lazy-input' });
      const context = appendUserContextMessage(projectRoot, 'planner:project', 'lazy-input', 'planner_state', 0, 'lazy planner state');
      return { ...input('lazy-input'), contextMessages: [context] };
    });

    await expect(harness.resolveForTest(actor, factory)).resolves.toMatchObject({ type: 'result' });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(readConversationMessages(projectRoot, 'planner:project')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activity', role: 'system', content: expect.stringContaining('activation_open') }),
      expect.objectContaining({ kind: 'text', role: 'user', content: 'lazy planner state' }),
    ]));
  }));

  it('persists active reconstruction while calling the provider', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve({ kind: 'message' as const, content: 'done' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('calling_provider'));
    const snapshot = readActorSnapshots(projectRoot).find((candidate) => candidate.actor_id === 'planner:project');
    const active = snapshot?.context.active_reconstruction;

    expect(snapshot?.context).toEqual({
      projectRoot,
      agentId: 'planner:project',
      active_reconstruction: expect.any(Object),
      compacting: false,
    });
    expect(active).toMatchObject({
      schema_version: 1,
      kind: 'llm_turn',
      agent_id: 'planner:project',
      role: 'planner',
      card_id: 'project',
      input_id: 'turn-1',
      provider_call_id: 'planner:project:turn-1',
      waiting_tool_call: null,
      delivered_tool_call_ids: [],
      tool_delivery_counter: 0,
    });
    expect(snapshot?.context).not.toHaveProperty('input');
    expect(snapshot?.context).not.toHaveProperty('outcome');
    expect(snapshot?.context).not.toHaveProperty('waitingToolCall');
    expect(snapshot?.context).not.toHaveProperty('deliveredToolCallIds');
    expect(snapshot?.context).not.toHaveProperty('toolDeliveryCounter');
    await eventually(() => expect(typeof finish).toBe('function'));
    finish();
    await expect(pending).resolves.toMatchObject({ type: 'result' });
  }));

  it('accepts analyst actor ids and persists nullable reconstruction card ids', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve({ kind: 'message' as const, content: 'done' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'analyst:global', provider });
    actor.start();

    const pending = actor.turn({ ...input(), agentId: 'analyst:global', role: 'analyst', sessionId: 'analyst:global', episodeContext: { cardId: null } });
    await eventually(() => expect(actor.state()).toBe('calling_provider'));

    expect(actorKindFromId('analyst:global')).toBe('llm');
    expect(parseLlmActorId('analyst:global')).toEqual({ role: 'analyst', cardId: null });
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'analyst:global')?.context.active_reconstruction).toMatchObject({ role: 'analyst', card_id: null });
    await eventually(() => expect(typeof finish).toBe('function'));
    finish();
    await expect(pending).resolves.toMatchObject({ type: 'result' });
  }));

  it('waits at the runtime gate instead of failing a provider turn while paused', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const gate = new RuntimeGate(false);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider, gate });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('calling_provider'));
    expect(provider.completeTurn).not.toHaveBeenCalled();
    gate.open();

    await expect(pending).resolves.toMatchObject({ type: 'result' });
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
  }));

  it('persists tool calls, accepts one tool result, and continues the turn', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (turnInput: LlmInvocationInput) => turnInput.episodeContext.lastToolResult
        ? { kind: 'message' as const, content: 'continued' }
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{"ok":true}' } }] }),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const first = await actor.turn(input());

    expect(first).toEqual({ type: 'tool_call', agentId: 'planner:project', inputId: 'turn-1', toolCallId: 'call-1', toolName: 'inspect', args: { ok: true } });
    await eventually(() => expect(actor.state()).toBe('waiting_tool'));
    expect(readConversationMessages(projectRoot, 'planner:project').filter((message) => message.kind === 'tool_call')).toHaveLength(1);
    expect(readConversationMessages(projectRoot, 'planner:project').filter((message) => message.kind === 'tool_result')).toHaveLength(0);
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'planner:project')?.context.active_reconstruction).toMatchObject({
      kind: 'llm_turn',
      input_id: 'turn-1',
      provider_call_id: null,
      waiting_tool_call: { sourceInputId: 'turn-1', toolCallId: 'call-1', toolName: 'inspect' },
      delivered_tool_call_ids: [],
      tool_delivery_counter: 0,
    });

    const second = await actor.appendToolResult('call-1', { success: true, data: { inspected: true } });

    expect(second).toMatchObject({ type: 'result', result: { content: 'continued' } });
    expect(readConversationMessages(projectRoot, 'planner:project').filter((message) => message.kind === 'tool_result')).toEqual([
      expect.objectContaining({ id: 'turn-1:tool:1:tool-result:call-1', tool_call_id: 'call-1', content: JSON.stringify({ success: true, data: { inspected: true } }) }),
    ]);
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
  }));

  it('continues after plain text with provider-visible repair context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (turnInput: LlmInvocationInput) => turnInput.inputId === 'turn-1'
        ? { kind: 'message' as const, content: 'plain text' }
        : { kind: 'message' as const, content: 'repaired' }),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await expect(actor.turn(input())).resolves.toMatchObject({ type: 'result', result: { content: 'plain text' } });
    const repaired = await actor.continueAfterPlainText('Use emit_result.');

    expect(repaired).toMatchObject({ type: 'result', result: { content: 'repaired' } });
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0];
    expect(repairInput.inputId).toBe('turn-1:tool:1');
    expect(repairInput.contextMessages).toEqual([
      { role: 'assistant', content: 'plain text' },
      { role: 'user', content: 'Use emit_result.' },
    ]);
    expect((actor.input?.contextMessages ?? []).filter((message) => (message as { role?: string; content?: string }).role === 'assistant' && (message as { content?: string }).content === 'plain text')).toHaveLength(1);
    const rows = jsonl(activeVersionPath(projectRoot, 'planner:project', 1));
    expect(rows.map((entry) => entry.kind)).toEqual(['system_prompt', 'activity', 'text', 'model_repair', 'activity', 'text']);
    expect(rows.find((entry) => entry.kind === 'model_repair')).toMatchObject({ role: 'user', content: 'Use emit_result.' });
  }));

  it('adds provider-visible tool history before hook continuation context', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const completeTurn = jest.fn(async (turnInput: LlmInvocationInput) => turnInput.episodeContext.lastToolResult
      ? { kind: 'message' as const, content: 'continued' }
      : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] });
    const provider: LLMProviderPort = { completeTurn };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await actor.turn({ ...input(), contextMessages: [{ role: 'user', content: 'base' }] });
    await eventually(() => expect(actor.state()).toBe('waiting_tool'));
    const hook = jest.fn((deliveryInputId: string) => [{ role: 'user', content: `notification for ${deliveryInputId}` }]);

    const result = { success: true, data: { inspected: true } } as const;
    await expect(actor.appendToolResult('call-1', result, undefined, hook)).resolves.toMatchObject({ type: 'result' });

    expect(hook).toHaveBeenCalledWith('turn-1:tool:1');
    const context = completeTurn.mock.calls[1]?.[0].contextMessages as Array<Record<string, unknown>>;
    expect(context).toHaveLength(4);
    expect(context[0]).toEqual({ role: 'user', content: 'base' });
    expect(context[1]).toMatchObject({ role: 'assistant', kind: 'tool_call', tool: 'inspect', tool_call_id: 'call-1' });
    expect(JSON.parse(String(context[1].content))).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
    });
    expect(context[2]).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'inspect', tool_call_id: 'call-1', content: JSON.stringify(result) });
    expect(context[3]).toMatchObject({ role: 'user', kind: 'text', content: 'notification for turn-1:tool:1' });
    expect(readConversationMessages(projectRoot, 'planner:project')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', kind: 'text', content: 'notification for turn-1:tool:1' }),
    ]));
  }));

  it('rejects duplicate tool settlement for the same call', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => ({ kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] })),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('waiting_tool'));
    const pending = actor.appendToolResult('call-1', { success: true });
    await expect(actor.appendToolResult('call-1', { success: true })).rejects.toThrow(/not waiting|already/);
    await expect(pending).resolves.toMatchObject({ type: 'tool_call' });
  }));

  it('clears delivered tool-call ids for top-level turns but not tool continuations', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (turnInput: LlmInvocationInput) => turnInput.episodeContext.lastToolResult
        ? { kind: 'message' as const, content: 'continued' }
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] }),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await actor.turn(input());
    await actor.appendToolResult('call-1', { success: true });
    expect(actor.deliveredToolCallIds.has('call-1')).toBe(true);

    await actor.turn(input('turn-2'));

    expect(actor.deliveredToolCallIds.has('call-1')).toBe(false);
    await expect(actor.appendToolResult('call-1', { success: true })).resolves.toMatchObject({ type: 'result' });
  }));

  it('settles late provider results for in-flight calls', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve({ kind: 'message' as const, content: 'late' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('calling_provider'));
    await eventually(() => expect(typeof finish).toBe('function'));
    finish();

    await expect(pending).resolves.toMatchObject({ type: 'result', result: { content: 'late' } });
    await eventually(() => expect(actor.state()).toBe('idle'));
  }));

  it('rejects the pending turn when entering provider call throws before provider registration', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    corruptActorMessages(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await expect(actor.turn(input())).rejects.toThrow(/JSON|parse|partial tail|refusing to append/);

    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));

  it('rejects the pending turn when provider on_done throws', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve({ kind: 'message' as const, content: 'done' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));
    corruptActorMessages(projectRoot);
    await eventually(() => expect(typeof finish).toBe('function'));
    finish();

    await expect(pending).rejects.toThrow(/JSON|parse|partial tail|refusing to append/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));

  it('rejects the pending turn when provider on_failed throws', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((_resolve, reject) => { fail = () => reject(new Error('provider failed')); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));
    corruptActorMessages(projectRoot);
    fail();

    await expect(pending).rejects.toThrow(/JSON|parse|partial tail|refusing to append/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));

  it('rejects the pending turn when provider task registration throws', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
    class ThrowingRunTaskLLMActor extends LLMActor {
      protected override runTask(): void {
        throw new Error('runTask exploded');
      }
    }
    const actor = new ThrowingRunTaskLLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await expect(actor.turn(input())).rejects.toThrow('runTask exploded');

    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));
});
