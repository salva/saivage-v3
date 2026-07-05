import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, TerminalCardProcessorActor, readActorSnapshots, type CardActorDeps, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import { closeOpenRecordSlot, openRecordSlot } from '../../../src/runtime/records/record-slots.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';

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

function executorResult(cardId: string, statusText: string, status: 'done' | 'failed' | 'blocked' = 'done') {
  void cardId;
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: `executor-${status}`, type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status, summary: statusText }) } }],
  };
}

function recordWrite(callId: string, path: string, content: string) {
  return {
    kind: 'tool_calls' as const,
    tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }],
  };
}

function invocationToolNames(input: LlmInvocationInput): string[] {
  return input.tools.map((tool) => tool.function.name).sort();
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
      if (result.kind === 'tool_calls' && result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result')) {
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

function processRunner(projectRoot: string): ProcessRunner {
  return new ProcessRunner(projectRoot);
}

function cardActorDeps(projectRoot: string, store: CardStore, provider: LLMProviderPort, runner = processRunner(projectRoot)): CardActorDeps {
  return { projectRoot, store, provider, processRunner: runner, notifyCard: () => ({ ok: true }), lookup: new Map() };
}

function actorFromCard(projectRoot: string, store: CardStore, card: ReturnType<typeof setup>['card'], processor: TerminalCardProcessorActor, provider: LLMProviderPort, runner?: ProcessRunner): CardActor {
  const actor = CardActor.fromCard({ card, deps: cardActorDeps(projectRoot, store, provider, runner) });
  Object.defineProperty(actor, 'processor', { value: processor });
  return actor;
}

function terminalProcessor(projectRoot: string, cardId: string, provider: LLMProviderPort, store?: CardStore, runner = processRunner(projectRoot)): TerminalCardProcessorActor {
  return new TerminalCardProcessorActor({ projectRoot, cardId, provider, processRunner: runner, store });
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
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented' });
    expect(store.read(card.id)).toMatchObject({ status: 'done', status_text: 'implemented' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'done', summary: 'implemented' });
    expect(provider.completeTurn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `executor:${card.id}`,
      role: 'executor',
      terminalToolNames: ['emit_result'],
      systemPrompt: expect.stringContaining('record://status.md?v=next'),
      tools: expect.arrayContaining(['read', 'write', 'glob', 'grep', 'edit', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'].map((name) => expect.objectContaining({ function: expect.objectContaining({ name }) }))),
    }), expect.any(AbortSignal));
    const input = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[0]?.[0];
    if (!input) throw new Error('Missing executor invocation input');
    const names = invocationToolNames(input);
    expect(names).toEqual([
      'apply_patch',
      'diff_card',
      'edit',
      'emit_result',
      'get_card_history_entry',
      'glob',
      'grep',
      'kill_process',
      'list_card_history',
      'mcp_tool_call',
      'read',
      'run_command',
      'skill',
      'wait_process',
      'webfetch',
      'websearch',
      'write',
    ].sort());
    expect(names).not.toEqual(expect.arrayContaining([
      'write_file',
      'terminate_process',
      'get_card_output',
      'restart_card_or_subtree',
      'restart_goal',
      'abort_goal_subtree',
      'mark_goal_needs_corrections',
      'create_plan',
      'update_plan',
    ]));
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
    const processor = terminalProcessor(projectRoot, card.id, provider);
    processor.start();

    const outcome = await processor.activate({ activationId: `card:${card.id}:activation:test`, card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done' });
  }));

  it('commits provider failure as failed outcome', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => { throw new Error('model unavailable'); }) };
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'failed', summary: 'model unavailable' });
    expect(store.read(card.id)?.lifecycle.result).toMatchObject({ kind: 'failed', summary: 'model unavailable' });
  }));

  it('commits accepted blocked executor results as blocked outcomes', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const provider = withExecutorStatusRecord(() => executorResult(card.id, 'waiting on operator', 'blocked'));
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'blocked', summary: 'waiting on operator', result: { kind: 'blocked', resume_reason: 'waiting on operator' } });
    expect(store.read(card.id)).toMatchObject({ status: 'blocked', status_text: 'waiting on operator' });
  }));

  it('persists active reconstruction during terminal processor activation and clears it on settlement', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let finish!: () => void;
    const provider = withExecutorStatusRecord(() => new Promise<LlmCompleteResult>((resolve) => { finish = () => resolve(executorResult(card.id, 'implemented')); }));
    const processor = terminalProcessor(projectRoot, card.id, provider);
    processor.start();

    const pending = processor.activate({ activationId: `card:${card.id}:activation:test`, card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);
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
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'failed', result: { kind: 'failed' } });
    expect(outcome.summary).toContain('emit_result');
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
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

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
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'bad-executor', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done' }) } }] };
      }
      expect(input.episodeContext.lastToolResult).toMatchObject({ result: { success: false, error: expect.any(String) } });
      return executorResult(card.id, 'valid after terminal repair');
    });
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'valid after terminal repair' });
  }));

  it('repairs missing executor status record before projecting the terminal result', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    const actions: string[] = [];
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => {
        const last = input.episodeContext.lastToolResult as { toolName?: string } | undefined;
        if (!last) {
          actions.push('emit_without_status');
          return executorResult(card.id, 'missing record first');
        }
        if (last.toolName === 'emit_result') {
          actions.push('write_status_after_repair');
          expect(store.read(card.id)?.status).toBe('running');
          return recordWrite('executor-status-after-repair', 'record://status.md?v=next', 'Executor status after repair.');
        }
        actions.push('emit_after_status');
        return executorResult(card.id, 'implemented after missing-record repair');
      }),
    };
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'implemented after missing-record repair' });
    expect(actions).toEqual(['emit_without_status', 'write_status_after_repair', 'emit_after_status']);
    const calls = (provider.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls.map(([input]) => input.sessionId)).toEqual([`executor:${card.id}`, `executor:${card.id}`, `executor:${card.id}`]);
    const repairInput = calls[1][0];
    const missingRecord = `Required record 'record://status.md?card=${card.id}&v=next' was not created.`;
    expect(repairInput.episodeContext.lastToolResult).toMatchObject({
      toolCallId: 'executor-done',
      toolName: 'emit_result',
      result: { success: false, error: missingRecord },
    });
    expect(repairInput.contextMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'executor-done' }),
      expect.objectContaining({ role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'executor-done', content: JSON.stringify({ success: false, error: missingRecord }) }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Create record://status.md?v=next, then call emit_result again.') }),
    ]));
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
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'continued after malformed write' });
    expect(sawMalformedWriteResult).toBe(true);
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
  }));

  it('returns missing record reads as recoverable tool results', async () => withTempProject(async (projectRoot) => {
    const { store, card } = setup(projectRoot);
    let sawMissingRecordResult = false;
    const provider = withExecutorStatusRecord((input: LlmInvocationInput) => {
      if (!input.episodeContext.lastToolResult) {
        return { kind: 'tool_calls' as const, tool_calls: [{ id: 'read-status-before-write', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'record://status.md' }) } }] };
      }
      sawMissingRecordResult = true;
      expect(input.episodeContext.lastToolResult).toMatchObject({
        toolName: 'read',
        result: { success: false, error: expect.stringContaining(`No closed record exists for '${card.id}/status'`) },
      });
      return executorResult(card.id, 'continued after missing record read');
    });
    const processor = terminalProcessor(projectRoot, card.id, provider, store);
    processor.start();
    const actor = actorFromCard(projectRoot, store, card, processor, provider);

    const outcome = await actor.activate({ kind: 'parent', cardId: 'project' });

    expect(outcome).toMatchObject({ status: 'done', summary: 'continued after missing record read' });
    expect(sawMissingRecordResult).toBe(true);
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
  }));

  it('cleans up a timed-out owned process when the terminal card settles', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider: LLMProviderPort = {
      completeTurn: jest.fn(async (input: LlmInvocationInput) => input.episodeContext.lastToolResult
        ? executorResult(card.id, 'saw running process')
        : { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: `${process.execPath} -e "setTimeout(() => console.log('late'), 1000)"`, wait: false }) } }] }),
    };
    const providerWithRecords = withExecutorStatusRecord(provider.completeTurn);
    const delivery = { deliverNotificationsForInput: jest.fn((inputId: string) => inputId.endsWith(':tool:1') ? [{ id: 'n-mid', message: 'executor mid-turn notice', created_at: '2026-06-12T00:00:00.000Z' }] : []) };
    const runner = processRunner(projectRoot);
    const processor = terminalProcessor(projectRoot, card.id, providerWithRecords, undefined, runner);
    processor.start();

    const outcome = await processor.activate({ activationId: `card:${card.id}:activation:test`, card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: delivery }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'saw running process' });
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1`);
    expect(delivery.deliverNotificationsForInput).toHaveBeenCalledWith(`terminal:${card.id}:1:tool:1`);
    const continuationContext = (providerWithRecords.completeTurn as jest.MockedFunction<LLMProviderPort['completeTurn']>).mock.calls[1]?.[0].contextMessages as Array<Record<string, unknown>>;
    expect(continuationContext).toHaveLength(3);
    expect(continuationContext[0]).toMatchObject({ role: 'assistant', kind: 'tool_call', tool: 'run_command', tool_call_id: 'run-1' });
    expect(continuationContext[1]).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'run_command', tool_call_id: 'run-1' });
    expect(continuationContext[2]).toEqual({ role: 'user', content: 'executor mid-turn notice' });
    await eventually(() => expect(runner.list().filter((process) => process.card_id === card.id)).toEqual([
      expect.objectContaining({ owner_id: `card:${card.id}:activation:test`, status: 'killed' }),
    ]));
  }));

  it('routes explicit process kill through ProcessProvider', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    const provider = withExecutorStatusRecord(async (input: LlmInvocationInput) => {
      const last = input.episodeContext.lastToolResult as { result?: { success?: boolean; data?: { running?: boolean; process_id?: string; terminated?: boolean } } } | undefined;
      if (!last) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'run-1', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: `${process.execPath} -e "setInterval(() => {}, 1000)"`, wait: false }) } }] };
      if (last.result?.data?.running && last.result.data.process_id) return { kind: 'tool_calls' as const, tool_calls: [{ id: 'kill-1', type: 'function' as const, function: { name: 'kill_process', arguments: JSON.stringify({ process_id: last.result!.data!.process_id }) } }] };
      return executorResult(card.id, 'killed process');
    });
    const runner = processRunner(projectRoot);
    const processor = terminalProcessor(projectRoot, card.id, provider, undefined, runner);
    processor.start();

    const outcome = await processor.activate({ activationId: `card:${card.id}:activation:test`, card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'killed process' });
    await eventually(() => expect(runner.list().filter((process) => process.card_id === card.id)).toEqual([
      expect.objectContaining({ owner_id: `card:${card.id}:activation:test`, status: 'killed', signal: 'SIGTERM' }),
    ]));
  }));

  it('keeps processing executor tool calls until a terminal result is produced', async () => withTempProject(async (projectRoot) => {
    const { card } = setup(projectRoot);
    let executorTurns = 0;
    const provider = withExecutorStatusRecord(async () => {
        executorTurns++;
        if (executorTurns <= 25) return { kind: 'tool_calls' as const, tool_calls: [{ id: `inspect-${executorTurns}`, type: 'function' as const, function: { name: 'wait_process', arguments: JSON.stringify({ process_id: 'missing', timeout_ms: 0 }) } }] };
        return executorResult(card.id, 'done after many tools');
    });
    const processor = terminalProcessor(projectRoot, card.id, provider);
    processor.start();

    const outcome = await processor.activate({ activationId: `card:${card.id}:activation:test`, card, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: noopNotificationDelivery() }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'done after many tools' });
    expect(executorTurns).toBe(26);
    const llmSnapshot = readActorSnapshots(projectRoot).find((snapshot) => snapshot.actor_id === `executor:${card.id}`);
    expect(llmSnapshot).toMatchObject({ state_value: 'idle', context: { active_reconstruction: null } });
  }));

  it('throws a clear impossible-state error when active recovery lacks activation input', () => withTempProject((projectRoot) => {
    const { card } = setup(projectRoot);
    const processor = terminalProcessor(projectRoot, card.id, { completeTurn: jest.fn(async () => executorResult(card.id, 'unused')) });

    expect(() => processor.recover('executing')).toThrow(/entered executing without activation input/);
  }));
});
