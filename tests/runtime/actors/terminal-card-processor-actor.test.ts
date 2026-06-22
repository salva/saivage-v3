import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, TerminalCardProcessorActor, readActorSnapshots, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-terminal-processor-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function setup(projectRoot: string) {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'write code', description: 'Implement it.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: 'Works.', retries: 0 });
  return { store, card };
}

async function eventually(assertion: () => void, attempts = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw lastError;
}

describe('TerminalCardProcessorActor', () => {
  it('runs a terminal card through executor LLM and commits accepted done result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'implemented' })) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented' });
    expect(store.read(card.id)).toMatchObject({ status: 'done', status_text: 'implemented' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'executor_success', executor: { summary: 'implemented' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `executor:${card.id}`, role: 'executor' }), expect.any(AbortSignal));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_kind)).toEqual(expect.arrayContaining(['card', 'llm', 'processor']));
  }));

  it('commits provider failure as failed outcome', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => { throw new Error('model unavailable'); }) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'failed', summary: 'model unavailable' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'executor_failure', error: 'model unavailable' });
  }));

  it('returns process wait timeout without killing the process', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? { kind: 'message' as const, content: 'saw running process' }
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-timeout', command: process.execPath, args: ['-e', 'setTimeout(() => console.log("late"), 80)'], timeoutMs: 5 }) } }] }),
    };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'done', summary: 'saw running process' });
    const processActor = processor.processes.get('P-timeout');
    expect(processActor).toBeDefined();
    expect(processActor?.pid).not.toBeNull();
    await expect(processActor!.wait(1000)).resolves.toMatchObject({ status: 'settled', exitCode: 0 });
  }));

  it('routes explicit process kill through ProcessActor', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { result?: { status?: string } } | undefined;
        if (!last) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-kill', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5 }) } }] };
        if (last.result?.status === 'running') return { kind: 'tool_calls' as const, tool_calls: [{ id: 'kill-1', type: 'function' as const, function: { name: 'kill_process', arguments: JSON.stringify({ processId: 'P-kill' }) } }] };
        return { kind: 'message' as const, content: 'killed process' };
      }),
    };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notifications: [] });

    expect(outcome).toMatchObject({ status: 'done', summary: 'killed process' });
    const processActor = processor.processes.get('P-kill');
    expect(processActor?.killReason).toBe('executor requested kill');
    await eventually(() => expect(processActor?.state()).toBe('settled'));
    expect(processActor?.signal).toBe('SIGTERM');
  }));
});
