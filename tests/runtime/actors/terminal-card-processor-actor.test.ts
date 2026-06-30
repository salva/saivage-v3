import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, MAX_TERMINAL_PROCESS_ACTORS, ProcessActor, TerminalCardProcessorActor, readActorSnapshots, readProcessEvidence, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import { closeOpenRecordSlot, openRecordSlot } from '../../../src/runtime/records/record-slots.js';

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
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'write code', brief: 'Implement it.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  return { store, card };
}

function writeBrief(projectRoot: string, cardId: string, content: string, cardVersionSeq = 1): void {
  const slot = openRecordSlot(projectRoot, { cardId, filename: 'brief.md' });
  writeFileSync(slot.absolutePath, content, 'utf-8');
  closeOpenRecordSlot(projectRoot, { cardId, filename: 'brief.md', writer: 'planner', cardVersionSeq });
}

function executorResult(cardId: string, statusText: string, status: 'done' | 'failed' = 'done') {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `executor-${status}`, type: 'function' as const, function: { name: 'emit_executor_result', arguments: JSON.stringify({ card_id: cardId, status, status_text: statusText, summary: statusText, error: status === 'failed' ? statusText : undefined, result: { summary: statusText }, warnings: [] }) } }],
  };
}

function recordWrite(callId: string, path: string, content: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }],
  };
}

function withExecutorStatusRecord(responder: (input: LlmInvocationInput, signal: AbortSignal) => Promise<LlmCompleteResult> | LlmCompleteResult): LLMProviderPort {
  const pending = new Map<string, LlmCompleteResult>();
  const statusWrites = new Map<string, number>();
  return {
    completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const key = input.sessionId;
      const pendingTerminal = pending.get(key);
      if (pendingTerminal) {
        if (!input.episodeContext.lastToolResult) {
          pending.delete(key);
        } else {
          pending.delete(key);
          return pendingTerminal;
        }
      }
      const result = await responder(input, new AbortController().signal);
      if (result.kind === 'tool_calls' && result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_executor_result')) {
        pending.set(key, result);
        const count = (statusWrites.get(key) ?? 0) + 1;
        statusWrites.set(key, count);
        return recordWrite(`status-${key}-${count}`, 'record://status.md?v=next', `Status for ${input.episodeContext.cardId ?? key}`);
      }
      return result;
    }),
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
    const provider = withExecutorStatusRecord(() => executorResult(card.id, 'implemented'));
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented' });
    expect(store.read(card.id)).toMatchObject({ status: 'done', status_text: 'implemented' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'executor_success', executor: { summary: 'implemented' } });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({ agentId: `executor:${card.id}`, role: 'executor', terminalToolNames: ['emit_executor_result'], systemPrompt: expect.stringContaining('record://status.md?v=next') }), expect.any(AbortSignal));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_kind)).toEqual(expect.arrayContaining(['card', 'llm', 'processor']));
  }));

  it('builds executor prompts from the latest brief record', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    writeBrief(projectRoot, card.id, '# Goal\n\nUse the brief record only.\n\n# Acceptance Criteria\n\nBrief acceptance.\n', card.version_seq);
    const provider = withExecutorStatusRecord((input: LlmInvocationInput) => {
      expect(input.systemPrompt).toContain('Use the brief record only.');
      expect(input.systemPrompt).toContain('Brief acceptance.');
      expect(input.systemPrompt).not.toContain('Implement it.');
      expect(input.systemPrompt).not.toContain('Works.');
      return executorResult(card.id, 'implemented');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done' });
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
    const provider = withExecutorStatusRecord(() => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve(executorResult(card.id, 'implemented')); }));
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
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
  }));

  it('repairs plain executor prose and succeeds when the model emits a terminal result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    let turns = 0;
    const provider = withExecutorStatusRecord(() => {
      turns++;
      if (turns === 1) return { kind: 'message' as const, content: 'I implemented it.' };
      return executorResult(card.id, 'implemented after repair');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented after repair' });
    const repairInput = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0];
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: 'I implemented it.' },
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Plain executor messages are not accepted') }),
    ]));
  }));

  it('repairs invalid executor terminal arguments before projecting the result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    let emittedInvalid = false;
    const provider = withExecutorStatusRecord((input: LlmInvocationInput) => {
      if (!emittedInvalid) {
        emittedInvalid = true;
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'bad-executor', type: 'function' as const, function: { name: 'emit_executor_result', arguments: JSON.stringify({ status: 'done' }) } }] };
      }
      expect(input.episodeContext.lastToolResult).toMatchObject({ result: { success: false, error: expect.any(String) } });
      return executorResult(card.id, 'valid after terminal repair');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'valid after terminal repair' });
  }));

  it('returns malformed workspace write arguments as a recoverable tool result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    let sawMalformedWriteResult = false;
    const provider = withExecutorStatusRecord((input: LlmInvocationInput) => {
      if (!input.episodeContext.lastToolResult) {
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'bad-write', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({}) } }] };
      }
      sawMalformedWriteResult = true;
      expect(input.episodeContext.lastToolResult).toMatchObject({
        toolName: 'write',
        result: { success: false, error: expect.stringContaining('path') },
      });
      expect(JSON.stringify(input.episodeContext.lastToolResult)).toContain('content');
      return executorResult(card.id, 'continued after malformed write');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();
    const actor = CardActor.fromCard({ projectRoot, card, store, processor });

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'continued after malformed write' });
    expect(sawMalformedWriteResult).toBe(true);
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
  }));

  it('cleans up a timed-out owned process when the terminal card settles', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? executorResult(card.id, 'saw running process')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-timeout', command: process.execPath, args: ['-e', 'setTimeout(() => console.log("late"), 80)'], timeoutMs: 5 }) } }] }),
    };
    const providerWithRecords = withExecutorStatusRecord(provider.completeTurn);
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'executor mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider: providerWithRecords });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: delivery });

    expect(outcome).toMatchObject({ status: 'done', summary: 'saw running process' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1`);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1:tool:1`);
    const continuationContext = (providerWithRecords.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0].contextMessages as Array<Record<string, unknown>>;
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
    const provider = withExecutorStatusRecord(async (input: LlmInvocationInput) => {
      const last = input.episodeContext.lastToolResult as { result?: { status?: string } } | undefined;
      if (!last) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_process', arguments: JSON.stringify({ processId: 'P-kill', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5 }) } }] };
      if (last.result?.status === 'running') return { kind: 'tool_calls' as const, tool_calls: [{ id: 'kill-1', type: 'function' as const, function: { name: 'kill_process', arguments: JSON.stringify({ processId: 'P-kill' }) } }] };
      return executorResult(card.id, 'killed process');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'killed process' });
    expect(processor.processes.size).toBe(0);
    await eventually(() => expect(readProcessEvidence(projectRoot, 'P-kill')).toMatchObject({ processId: 'P-kill', killReason: 'executor requested kill', signal: 'SIGTERM' }));
  }));

  it('keeps processing executor tool calls until a terminal result is produced', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let executorTurns = 0;
    const provider = withExecutorStatusRecord(async () => {
        executorTurns++;
        if (executorTurns <= 25) return { kind: 'tool_calls' as const, tool_calls: [{ id: `inspect-${executorTurns}`, type: 'function' as const, function: { name: 'inspect_process', arguments: JSON.stringify({ processId: 'missing' }) } }] };
        return executorResult(card.id, 'done after many tools');
    });
    const processor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, provider });
    processor.start();

    const outcome = await processor.activate({ card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() });

    expect(outcome).toMatchObject({ status: 'done', summary: 'done after many tools' });
    expect(executorTurns).toBe(26);
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
