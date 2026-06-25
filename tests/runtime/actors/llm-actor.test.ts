import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { actorMessagesPath, actorToolCallStatusesPath, LLMActor, readActorSnapshots, type LLMAdmissionPort, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';

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
  const path = actorMessagesPath(projectRoot, 'planner:project');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"partial"', 'utf-8');
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
      waiting_tool: { parked: true, on: { turn: 'calling_provider' } },
    });
  });

  it('persists invocation context before provider call and records message results', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let sawStartedMessage = false;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        sawStartedMessage = jsonl(actorMessagesPath(projectRoot, 'planner:project')).some((entry) => String(entry.id).endsWith(':started'));
        return { kind: 'message' as const, content: 'done' };
      }),
    };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const outcome = await actor.turn(input());

    expect(sawStartedMessage).toBe(true);
    expect(outcome).toMatchObject({ type: 'result', result: { content: 'done' } });
    await eventually(() => expect(actor.state()).toBe('idle'));
    expect(jsonl(actorMessagesPath(projectRoot, 'planner:project')).map((entry) => entry.kind)).toEqual(['activity', 'text']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toContain('planner:project');
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'planner:project')?.context.active_reconstruction).toBeNull();
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
    finish();
    await expect(pending).resolves.toMatchObject({ type: 'result' });
  }));

  it('returns provider admission denial without calling the provider', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
    const admission: LLMAdmissionPort = { requestProviderCall: jest.fn(() => false), releaseProviderCall: jest.fn() };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider, admission });
    actor.start();

    const outcome = await actor.turn(input());

    expect(outcome).toMatchObject({ type: 'error', error: expect.stringContaining('Provider admission denied') });
    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect(admission.releaseProviderCall).not.toHaveBeenCalled();
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
    expect(jsonl(actorToolCallStatusesPath(projectRoot, 'planner:project')).map((entry) => entry.status)).toEqual(['pending']);
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === 'planner:project')?.context.active_reconstruction).toMatchObject({
      kind: 'llm_turn',
      input_id: 'turn-1',
      provider_call_id: null,
      waiting_tool_call: { sourceInputId: 'turn-1', toolCallId: 'call-1', toolName: 'inspect' },
      delivered_tool_call_ids: [],
      tool_delivery_counter: 0,
    });

    const second = await actor.appendToolResult('call-1', { inspected: true });

    expect(second).toMatchObject({ type: 'result', result: { content: 'continued' } });
    expect(jsonl(actorToolCallStatusesPath(projectRoot, 'planner:project')).map((entry) => entry.status)).toEqual(['pending', 'delivered']);
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
  }));

  it('adds result continuation context from the delivery input hook', async () => withTempProject(async (projectRoot) => {
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

    await expect(actor.appendToolResult('call-1', { inspected: true }, hook)).resolves.toMatchObject({ type: 'result' });

    expect(hook).toHaveBeenCalledWith('turn-1:tool:1');
    expect(completeTurn.mock.calls[1]?.[0].contextMessages).toEqual([
      { role: 'user', content: 'base' },
      { role: 'user', content: 'notification for turn-1:tool:1' },
    ]);
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
    const pending = actor.appendToolResult('call-1', {});
    await expect(actor.appendToolResult('call-1', {})).rejects.toThrow(/not waiting|already/);
    await expect(pending).resolves.toMatchObject({ type: 'tool_call' });
  }));

  it('settles late provider results for in-flight calls', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve({ kind: 'message' as const, content: 'late' }); })) };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    const pending = actor.turn(input());
    await eventually(() => expect(actor.state()).toBe('calling_provider'));
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

    await expect(actor.turn(input())).rejects.toThrow(/partial tail|refusing to append/);

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
    finish();

    await expect(pending).rejects.toThrow(/partial tail|refusing to append/);
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

    await expect(pending).rejects.toThrow(/partial tail|refusing to append/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));

  it('releases acquired provider admission when provider task registration throws', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
    const admission: LLMAdmissionPort = { requestProviderCall: jest.fn(() => true), releaseProviderCall: jest.fn() };
    class ThrowingRunTaskLLMActor extends LLMActor {
      protected override runTask(): void {
        throw new Error('runTask exploded');
      }
    }
    const actor = new ThrowingRunTaskLLMActor({ projectRoot, agentId: 'planner:project', provider, admission });
    actor.start();

    await expect(actor.turn(input())).rejects.toThrow('runTask exploded');

    expect(admission.requestProviderCall).toHaveBeenCalledWith('planner:project:turn-1');
    expect(admission.releaseProviderCall).toHaveBeenCalledWith('planner:project:turn-1');
    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("LLMActor 'planner:project' fatal handler failure"), expect.any(Error));
    consoleError.mockRestore();
  }));
});
