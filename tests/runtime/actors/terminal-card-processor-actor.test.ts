import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, MAX_TERMINAL_PROCESS_ACTORS, MAX_TERMINAL_TOOL_TURNS, ProcessActor, TerminalCardProcessorActor, readActorSnapshots, readProcessEvidence, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';

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

function executorResult(cardId: string, statusText: string, status: 'done' | 'failed' = 'done') {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `executor-${status}`, type: 'function' as const, function: { name: 'emit_executor_result', arguments: JSON.stringify({ card_id: cardId, status, status_text: statusText, summary: statusText, error: status === 'failed' ? statusText : undefined, result: { summary: statusText }, artifacts: [], attachments: [], generated_files: [`${cardId}.txt`], warnings: [] }) } }],
  };
}

function executorResultWithEvidence(cardId: string, artifactPath: string, attachmentPath: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: 'executor-evidence', type: 'function' as const, function: { name: 'emit_executor_result', arguments: JSON.stringify({ card_id: cardId, status: 'done', status_text: 'implemented with evidence', summary: 'implemented with evidence', result: { summary: 'implemented with evidence' }, artifacts: [{ type: 'log', description: 'build log', retain: true, path: artifactPath }], attachments: [{ mime: 'text/plain', title: 'notes', path: attachmentPath }], generated_files: ['src/example.ts'], warnings: ['manual review advised'] }) } }],
  };
}

function noopNotificationDelivery() {
  return { deliverNotificationsForInput: () => [] };
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
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => executorResult(card.id, 'implemented')) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented' });
    expect(store.read(card.id)).toMatchObject({ status: 'done', status_text: 'implemented' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'executor_success', executor: { summary: 'implemented' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `executor:${card.id}`, role: 'executor', terminalToolNames: ['emit_executor_result'] }), expect.any(AbortSignal));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_kind)).toEqual(expect.arrayContaining(['card', 'llm', 'processor']));
  }));

  it('preserves executor artifacts and attachments through card evidence refs and schema-valid result fields', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => executorResultWithEvidence(card.id, '.saivage-work/logs/build.log', '.saivage-work/logs/notes.txt')) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider, store });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', result: { kind: 'executor_success', generated_files: ['src/example.ts'], warnings: ['manual review advised'] } });
    expect(outcome.result.executor).toMatchObject({ artifact_refs: [expect.objectContaining({ path: '.saivage-work/logs/build.log' })], attachment_refs: [expect.objectContaining({ path: '.saivage-work/logs/notes.txt' })] });
    expect(store.read(card.id)?.artifacts).toEqual([expect.objectContaining({ path: '.saivage-work/logs/build.log', type: 'log' })]);
    expect(store.read(card.id)?.attachments).toEqual([expect.objectContaining({ path: '.saivage-work/logs/notes.txt', title: 'notes' })]);
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

  it('persists active reconstruction during terminal processor activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let finish!: () => void;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve(executorResult(card.id, 'implemented')); })) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const pending = processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });
    await eventually(() => expect(processor.state()).toBe('executing'));
    expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `processor:${card.id}`)?.context.active_reconstruction).toMatchObject({
      schema_version: 1,
      kind: 'processor_activation',
      processor_kind: 'terminal',
      card_id: card.id,
      caller: { kind: 'parent', cardId: 'project' },
      activation_counter: 1,
    });

    finish();
    await expect(pending).resolves.toMatchObject({ status: 'done' });
    await eventually(() => expect(readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `processor:${card.id}`)?.context.active_reconstruction).toBeNull());
  }));

  it('does not accept plain executor prose as terminal result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'implemented' })) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'executor_failure' } });
    expect(outcome.summary).toContain('emit_executor_result');
  }));

  it('cleans up a timed-out owned process when the terminal card settles', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? executorResult(card.id, 'saw running process')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-timeout', command: process.execPath, args: ['-e', 'setTimeout(() => console.log("late"), 80)'], timeoutMs: 5 }) } }] }),
    };
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'executor mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done', summary: 'saw running process' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1`);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1:tool:1`);
    const continuationContext = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0].contextMessages as Array<Record<string, unknown>>;
    expect(continuationContext).toHaveLength(3);
    expect(continuationContext[0]).toMatchObject({ role: 'assistant', kind: 'tool_call', tool: 'run_process', tool_call_id: 'run-1' });
    expect(continuationContext[1]).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'run_process', tool_call_id: 'run-1' });
    expect(continuationContext[2]).toEqual({ role: 'user', content: 'executor mid-turn notice' });
    expect(processor.processes.size).toBe(0);
    await eventually(() => expect(readProcessEvidence(projectRoot, 'P-timeout')).toMatchObject({ processId: 'P-timeout', killReason: 'terminal card settled' }));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toContain('process:P-timeout');
  }));

  it('routes explicit process kill through ProcessActor', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { result?: { status?: string } } | undefined;
        if (!last) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-kill', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5 }) } }] };
        if (last.result?.status === 'running') return { kind: 'tool_calls' as const, tool_calls: [{ id: 'kill-1', type: 'function' as const, function: { name: 'kill_process', arguments: JSON.stringify({ processId: 'P-kill' }) } }] };
        return executorResult(card.id, 'killed process');
      }),
    };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'killed process' });
    expect(processor.processes.size).toBe(0);
    await eventually(() => expect(readProcessEvidence(projectRoot, 'P-kill')).toMatchObject({ processId: 'P-kill', killReason: 'executor requested kill', signal: 'SIGTERM' }));
  }));

  it('accepts a terminal executor result produced by the final allowed tool append', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let executorTurns = 0;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        executorTurns++;
        if (executorTurns <= MAX_TERMINAL_TOOL_TURNS) return { kind: 'tool_calls' as const, tool_calls: [{ id: `inspect-${executorTurns}`, type: 'function' as const, function: { name: 'inspect_process', arguments: JSON.stringify({ processId: 'missing' }) } }] };
        return executorResult(card.id, 'done at boundary');
      }),
    };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done at boundary' });
    expect(executorTurns).toBe(MAX_TERMINAL_TOOL_TURNS + 1);
  }));

  it('fails the executor budget when the final allowed tool append is non-terminal', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let executorTurns = 0;
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async () => {
        executorTurns++;
        return { kind: 'tool_calls' as const, tool_calls: [{ id: `inspect-${executorTurns}`, type: 'function' as const, function: { name: 'inspect_process', arguments: JSON.stringify({ processId: 'missing' }) } }] };
      }),
    };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'failed', summary: 'Executor exceeded terminal turn budget.', result: { kind: 'executor_failure', error: 'Executor exceeded terminal turn budget.' } });
    expect(executorTurns).toBe(MAX_TERMINAL_TOOL_TURNS + 1);
    const llmSnapshot = readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `executor:${card.id}`);
    expect(llmSnapshot).toMatchObject({ state_value: 'idle', context: { active_reconstruction: null } });
  }));

  it('compacts old settled process actors', () => withTempProject((projectRoot) => {
    const { card } = setup(projectRoot);
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider: { completeTurn: jest.fn(async () => executorResult(card.id, 'unused')) } });
    for (let index = 0; index < MAX_TERMINAL_PROCESS_ACTORS + 3; index++) {
      const processActor = new ProcessActor({ projectRoot, processId: `P-${index}` });
      processActor.recover('settled');
      processor.processes.set(processActor.processId, processActor);
    }

    (processor as unknown as { compactProcessActors: () => void }).compactProcessActors();

    expect([...processor.processes.keys()]).toHaveLength(MAX_TERMINAL_PROCESS_ACTORS);
    expect([...processor.processes.keys()][0]).toBe('P-3');
    expect([...processor.processes.keys()].at(-1)).toBe(`P-${MAX_TERMINAL_PROCESS_ACTORS + 2}`);
  }));

  it('throws a clear impossible-state error when recovering directly into executing', () => withTempProject((projectRoot) => {
    const { card } = setup(projectRoot);
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider: { completeTurn: jest.fn(async () => executorResult(card.id, 'unused')) } });

    expect(() => processor.recover('executing')).toThrow(/cannot recover directly into active state 'executing'/);
  }));
});
