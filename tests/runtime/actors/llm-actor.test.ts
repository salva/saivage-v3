import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    episodeContext: {},
  };
}

function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function eventually(assertion: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 0)); }
  }
  throw lastError;
}

describe('LLMActor', () => {
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

  it('adds error continuation context from the delivery input hook', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const completeTurn = jest.fn(async (turnInput: LlmInvocationInput) => turnInput.episodeContext.lastToolResult
      ? { kind: 'message' as const, content: 'continued after error' }
      : { kind: 'tool_calls' as const, tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] });
    const provider: LLMProviderPort = { completeTurn };
    const actor = new LLMActor({ projectRoot, agentId: 'planner:project', provider });
    actor.start();

    await actor.turn({ ...input(), contextMessages: [{ role: 'user', content: 'base' }] });
    await eventually(() => expect(actor.state()).toBe('waiting_tool'));
    const hook = jest.fn((deliveryInputId: string) => [{ role: 'user', content: `error notification for ${deliveryInputId}` }]);

    await expect(actor.appendToolError('call-1', 'tool failed', hook)).resolves.toMatchObject({ type: 'result' });

    expect(hook).toHaveBeenCalledWith('turn-1:tool:1');
    expect(completeTurn.mock.calls[1]?.[0].contextMessages).toEqual([
      { role: 'user', content: 'base' },
      { role: 'user', content: 'error notification for turn-1:tool:1' },
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
    const pending = actor.appendToolError('call-1', 'tool failed');
    await expect(actor.appendToolResult('call-1', {})).rejects.toThrow(/not waiting|already/);
    await expect(pending).resolves.toMatchObject({ type: 'tool_call' });
  }));

  it('continues to accept late provider results because cancellation is card-owned', async () => withTempProject(async (projectRoot) => {
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
});
