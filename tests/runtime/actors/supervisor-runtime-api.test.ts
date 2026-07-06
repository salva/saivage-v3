import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { appendLlmTurnFinished, createSupervisorRuntimeApi, readActorSnapshots, readRecoveryDiagnostics, readToolCallStatuses, RuntimeSupervisorActor, saveActorSnapshot, SupervisorRuntimeApi, type CardActorStorePort, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { actorToolCallStatusesPath, appendToolCallStatus } from '../../../src/runtime/actors/index.js';
import type { LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import type { CardRecord } from '../../../src/schemas/index.js';
import { openRecordSlot } from '../../../src/runtime/records/record-slots.js';
import { readRuntimeState } from '../../../src/runtime/state-api.js';
import { createRuntimeStateMutationPort } from '../../../src/runtime/mutations.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-api-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function testProcessRunner(projectRoot: string): ProcessRunner {
  return new ProcessRunner(projectRoot);
}

async function waitForRootRun(projectRoot: string, predicate: (run: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const run = readRuntimeState(projectRoot)?.runtime_runs.find((item) => item.kind === 'root');
    if (run && predicate(run as unknown as Record<string, unknown>)) return run as unknown as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for root run. State: ${JSON.stringify(readRuntimeState(projectRoot))}`);
}

async function eventually(assertion: () => void, attempts = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw lastError;
}

function createProject(store: CardStore): CardRecord {
  const existing = store.read('project');
  if (existing) return existing;
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
}

function createDoneEvidence(store: CardStore, parent = 'project'): CardRecord {
  const card = store.create({ type: 'goal', parent, depth: 1, title: 'evidence', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  return store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'evidence done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

const inertStore: CardActorStorePort = {
  read: () => null,
  setStatus: () => { throw new Error('Unexpected setStatus call.'); },
  commitTerminalLifecyclePatch: () => { throw new Error('Unexpected commitTerminalLifecyclePatch call.'); },
};

function blockedPlannerProvider(): LLMProviderPort {
  return withMandatoryRecords(() => ({ kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'waiting for operator' }) } }] }));
}

function doneProjectProvider(_evidenceId: string): LLMProviderPort {
  return withMandatoryRecords((input: LlmInvocationInput) => input.role === 'reviewer'
    ? { kind: 'tool_calls' as const, tool_calls: [{ id: 'reviewer-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done', summary: 'project reviewed' }) } }] }
    : { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done', summary: 'project completed' }) } }] });
}

function failedPlannerProvider(): LLMProviderPort {
  return { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'plain messages fail planner activation' })) };
}

function recordWrite(callId: string, path: string, content: string): LlmCompleteResult {
  return { kind: 'tool_calls' as const, tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }] };
}

function withMandatoryRecords(responder: (input: LlmInvocationInput) => Promise<LlmCompleteResult> | LlmCompleteResult): LLMProviderPort {
  const pending = new Map<string, LlmCompleteResult>();
  return {
    completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const pendingTerminal = pending.get(input.sessionId);
      if (pendingTerminal) {
        pending.delete(input.sessionId);
        return pendingTerminal;
      }
      const result = await responder(input);
      if (result.kind !== 'tool_calls') return result;
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'planner') {
        pending.set(input.sessionId, result);
        return recordWrite(`status-${input.sessionId}`, 'record://status.md?v=next', `Status for ${input.episodeContext.cardId}`);
      }
      if (result.tool_calls.some((toolCall) => toolCall.function.name === 'emit_result') && input.role === 'reviewer') {
        pending.set(input.sessionId, result);
        return recordWrite(`review-${input.sessionId}`, 'record://review.md?v=next', `Review for ${input.episodeContext.cardId}`);
      }
      return result;
    }),
  };
}

function cardActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'card_activation', card_id: cardId, processor_actor_id: `processor:${cardId}`, caller: { kind: 'root' }, started_at: '2026-06-12T00:00:00.000Z' };
}

function processorActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'processor_activation', processor_kind: 'planning', card_id: cardId, caller: { kind: 'root' }, activation_counter: 1, started_at: '2026-06-12T00:00:00.000Z' };
}

function terminalProcessorActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'processor_activation', processor_kind: 'terminal', card_id: cardId, caller: { kind: 'parent', cardId: 'project', sessionId: 'planner:project' }, activation_counter: 1, started_at: '2026-06-12T00:00:00.000Z' };
}

function llmActive(cardId: string): Record<string, unknown> {
  const inputId = `planner:${cardId}:1`;
  return { schema_version: 1, kind: 'llm_turn', agent_id: `planner:${cardId}`, role: 'planner', card_id: cardId, input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, provider_call_id: null, waiting_tool_call: null, delivered_tool_call_ids: [], tool_delivery_counter: 0, started_at: '2026-06-12T00:00:00.000Z' };
}

function plannerWaitingActive(cardId: string, toolName: string, toolCallId = 'call-1'): Record<string, unknown> {
  const inputId = `planner:${cardId}:1`;
  return { ...llmActive(cardId), input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, waiting_tool_call: { sourceInputId: inputId, toolCallId, toolName } };
}

function reviewerWaitingActive(cardId: string, toolName: string, toolCallId = 'call-1', assessmentId = `assessment-${cardId}-1`): Record<string, unknown> {
  const inputId = `reviewer:${cardId}:1`;
  return { ...llmActive(cardId), agent_id: `reviewer:${cardId}`, role: 'reviewer', input_id: inputId, input: { inputId, agentId: `reviewer:${cardId}`, role: 'reviewer', sessionId: `reviewer:${cardId}:${assessmentId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId, assessmentId } }, waiting_tool_call: { sourceInputId: inputId, toolCallId, toolName } };
}

function executorWaitingActive(cardId: string, toolName: string, toolCallId = 'call-1'): Record<string, unknown> {
  const inputId = `terminal:${cardId}:1`;
  const agentId = `executor:${cardId}`;
  return { ...llmActive(cardId), agent_id: agentId, role: 'executor', input_id: inputId, input: { inputId, agentId, role: 'executor', sessionId: agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId, caller: { kind: 'parent', cardId: 'project', sessionId: 'planner:project' }, activationId: `card:${cardId}:activation:1` } }, waiting_tool_call: { sourceInputId: inputId, toolCallId, toolName } };
}

function appendPlannerToolCall(projectRoot: string, cardId: string, toolName: string, args: unknown, toolCallId = 'call-1'): void {
  const inputId = `planner:${cardId}:1`;
  const agentId = `planner:${cardId}`;
  appendLlmTurnFinished(projectRoot, { inputId, agentId, role: 'planner', sessionId: agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, { kind: 'tool_calls', tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] });
  if (toolName === 'emit_result') writeRequiredRecord(projectRoot, cardId, 'status.md', 'planner startup recovery record');
}

function appendReviewerToolCall(projectRoot: string, cardId: string, args: unknown, toolCallId = 'call-1', assessmentId = `assessment-${cardId}-1`): void {
  const inputId = `reviewer:${cardId}:1`;
  const agentId = `reviewer:${cardId}`;
  appendLlmTurnFinished(projectRoot, { inputId, agentId, role: 'reviewer', sessionId: `${agentId}:${assessmentId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId, assessmentId } }, { kind: 'tool_calls', tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'emit_result', arguments: JSON.stringify(args) } }] });
  writeRequiredRecord(projectRoot, cardId, 'review.md', 'reviewer startup recovery record');
}

function appendExecutorToolCall(projectRoot: string, cardId: string, toolName: string, args: unknown, toolCallId = 'call-1'): void {
  const inputId = `terminal:${cardId}:1`;
  const agentId = `executor:${cardId}`;
  appendLlmTurnFinished(projectRoot, { inputId, agentId, role: 'executor', sessionId: agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId, caller: { kind: 'parent', cardId: 'project', sessionId: 'planner:project' }, activationId: `card:${cardId}:activation:1` } }, { kind: 'tool_calls', tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] });
}

function writeRequiredRecord(projectRoot: string, cardId: string, filename: 'status.md' | 'review.md', content: string): void {
  const record = openRecordSlot(projectRoot, { cardId, filename });
  writeFileSync(record.absolutePath, content, 'utf8');
}

describe('SupervisorRuntimeApi', () => {
  it('supervisor no longer tracks provider-call state', () => withTempProject((projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();

    expect(supervisor.work).toBe('ready');
    expect(supervisor.snapshot().context).toEqual({ projectRoot });
  }));

  it('transitions shutdown directly to idle without fake asynchronous work', () => withTempProject((projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();

    expect(supervisor.shutdown()).toBe(true);

    expect(supervisor.mode).toBe('idle');
    expect(supervisor.work).toBe('ready');
  }));

  it('implements start, pause, resume, status, and shutdown through RuntimeSupervisorActor', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(() => api.pause()).toThrow("Cannot pause runtime from 'idle'.");

    const start = await api.startProject('operator');
    expect(start.success).toBe(true);
    if (!start.success) throw new Error('Expected startProject to succeed.');
    expect(start.command).toMatchObject({ command: 'start_project', status: 'accepted' });
    expect(start.run).toMatchObject({ phase: 'pending', runtime_status: 'running', finished_at: null, outcome: null });
    expect(readRuntimeState(projectRoot)?.runtime_commands.at(-1)).toMatchObject({ command: 'start_project', status: 'accepted' });
    expect(readRuntimeState(projectRoot)?.runtime_runs.at(-1)).toMatchObject({ run_id: start.run.run_id, phase: 'pending', runtime_status: 'running' });
    expect(api.getStatus()).toMatchObject({ status: 'running', currentCardId: 'project' });
    const duplicateStart = await api.startProject('operator');
    expect(duplicateStart.success).toBe(false);
    if (!duplicateStart.success) expect(duplicateStart.error.code).toBe('runtime_already_running');
    await waitForRootRun(projectRoot, (run) => run.phase === 'blocked');
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(() => api.pause()).toThrow("Cannot pause runtime from 'idle'.");
    expect(() => api.resume()).toThrow("Cannot resume runtime from 'idle'.");
    expect(api.getActorRuntimeReadModel()).toMatchObject({
      pauseMode: 'idle',
      cards: [{ cardId: 'project', actorState: 'blocked' }],
      agents: [],
    });
    await api.shutdown();

    expect(readActorSnapshots(projectRoot).some((item) => item.actor_id === 'supervisor')).toBe(true);
  }));

  it('resume opens the runtime gate without requiring a second run command', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    let finish!: () => void;
    const provider = withMandatoryRecords(async () => new Promise<LlmCompleteResult>((resolve) => {
        finish = () => resolve({ kind: 'tool_calls', tool_calls: [{ id: 'planner-result-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'resumed work' }) } }] });
      }));
    const gate = new RuntimeGate();
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider, processRunner: testProcessRunner(projectRoot), runtimeGate: gate, now: () => '2026-06-12T00:00:00.000Z' });

    const start = await api.startProject('operator');
    expect(start.success).toBe(true);
    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'paused', currentCardId: 'project' });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readRuntimeState(projectRoot)?.runtime_runs.at(-1)).toMatchObject({ phase: 'pending', runtime_status: 'running' });

    api.resume();

    const terminal = await waitForRootRun(projectRoot, (run) => run.phase === 'blocked');
    expect(terminal).toMatchObject({ phase: 'blocked', outcome: { kind: 'blocked', error: 'resumed work' } });
    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
  }));

  it('settles blocked root project activations without projecting active runtime work', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    const result = await api.startProject('operator');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected startProject to succeed.');

    expect(result.run).toMatchObject({ phase: 'pending', runtime_status: 'running', finished_at: null, outcome: null });
    const terminal = await waitForRootRun(projectRoot, (run) => run.phase === 'blocked');
    expect(terminal).toMatchObject({ phase: 'blocked', runtime_status: 'stopped', finished_at: null, outcome: { kind: 'blocked', error: 'waiting for operator' } });
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null, goalCount: 0 });
    expect(api.getActorRuntimeReadModel()).toMatchObject({ pauseMode: 'idle', activeWork: 'none' });
    expect(readToolCallStatuses(projectRoot, 'planner:project').filter((record) => record.tool_name === 'emit_result').map((record) => record.status)).toEqual(['pending', 'terminal_projected']);
  }));

  it('settles failed root project activations without projecting active runtime work', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider: failedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    const result = await api.startProject('operator');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected startProject to succeed.');

    expect(result.run).toMatchObject({ phase: 'pending', runtime_status: 'running', finished_at: null, outcome: null });
    const terminal = await waitForRootRun(projectRoot, (run) => run.phase === 'failed');
    expect(terminal).toMatchObject({ phase: 'failed', runtime_status: 'stopped', finished_at: '2026-06-12T00:00:00.000Z', outcome: { kind: 'completed', result: 'failed' } });
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null, goalCount: 0 });
    expect(api.getActorRuntimeReadModel()).toMatchObject({ pauseMode: 'idle', activeWork: 'none' });
  }));

  it('captures the actor recovery plan before starting the supervisor', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-recover',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'G-recover', active_reconstruction: cardActive('G-recover') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-recover',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: 'G-recover', active_reconstruction: llmActive('G-recover') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(readRecoveryDiagnostics(projectRoot)?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:G-recover', kind: 'active_card', cardId: 'G-recover' }),
      expect.objectContaining({ actorId: 'planner:G-recover', kind: 'active_llm', cardId: 'G-recover' }),
    ]));
  }));

  it('reconciles persisted processes before actor startup recovery', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const order: string[] = [];
    const processRunner = testProcessRunner(projectRoot);
    jest.spyOn(processRunner, 'reconcile').mockImplementation(async () => {
      order.push('process-reconcile');
      return { matched: [], lost: [], skewed: [] };
    });
    const api = new SupervisorRuntimeApi({
      projectRoot,
      actorStore: store,
      provider: blockedPlannerProvider(),
      processRunner,
      now: () => {
        order.push('actor-recovery');
        return '2026-06-12T00:00:00.000Z';
      },
    });

    await api.start();

    expect(order.slice(0, 2)).toEqual(['process-reconcile', 'actor-recovery']);
  }));

  it('persists only outstanding recovery diagnostics after handled cleanup', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-recover',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'G-recover', active_reconstruction: cardActive('G-recover') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-recover',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: 'G-recover', active_reconstruction: llmActive('G-recover') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:G-recover',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'G-recover', active_reconstruction: processorActive('G-recover') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(readRecoveryDiagnostics(projectRoot)).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ actorId: 'planner:G-recover', severity: 'warning' }),
        expect.objectContaining({ actorId: 'processor:G-recover', severity: 'warning' }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'card:G-recover', kind: 'active_card', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'planner:G-recover', kind: 'active_llm', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'planner:G-recover', kind: 'llm_recovery_action', action: 'reissue_provider_call', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'processor:G-recover', kind: 'active_processor', cardId: 'G-recover' }),
      ]),
    });
    expect(api.getStartupRecoveryReport()?.incidents).toEqual([]);
  }));

  it('abandons stale pending tool calls during startup recovery', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-stale',
      source_input_id: 'input:G-stale',
      tool_call_id: 'call-stale',
      tool_name: 'activate_card',
      status: 'pending',
    });
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-delivered',
      source_input_id: 'input:G-delivered',
      tool_call_id: 'call-delivered',
      tool_name: 'activate_card',
      status: 'pending',
    });
    appendToolCallStatus(projectRoot, {
      agent_id: 'planner:G-delivered',
      source_input_id: 'input:G-delivered',
      tool_call_id: 'call-delivered',
      tool_name: 'activate_card',
      status: 'delivered',
      delivery_input_id: 'input:G-delivered:child:1',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-stale')).map((entry) => entry.status)).toEqual(['pending', 'abandoned']);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-delivered')).map((entry) => entry.status)).toEqual(['pending', 'delivered']);
  }));

  it('reconstructs interrupted running card work paused during startup recovery', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.setStatus(project.id, 'running');
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:project',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'project', active_reconstruction: cardActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: 'project', active_reconstruction: llmActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:project',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'project', active_reconstruction: processorActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getStatus()).toMatchObject({ status: 'paused', currentCardId: null });
    expect(store.read(project.id)).toMatchObject({ status: 'running' });
    expect(readRecoveryDiagnostics(projectRoot)).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'card:project', kind: 'active_card' }),
        expect.objectContaining({ actorId: 'planner:project', kind: 'llm_recovery_action', action: 'reissue_provider_call' }),
        expect.objectContaining({ actorId: 'processor:project', kind: 'active_processor' }),
      ]),
    });
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:project', 'planner:project', 'processor:project']));
  }));

  it('does not synthesize interrupted results for non-replayable recovered executor tools', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const card = store.create({ type: 'test', parent: project.id, depth: 1, title: 'quality', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.setStatus(card.id, 'running');
    saveActorSnapshot(projectRoot, {
      actor_id: `card:${card.id}`,
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: card.id, active_reconstruction: cardActive(card.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: `executor:${card.id}`,
      actor_kind: 'llm',
      state_value: 'waiting_tool',
      context: { cardId: card.id, active_reconstruction: executorWaitingActive(card.id, 'run_command') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: `processor:${card.id}`,
      actor_kind: 'processor',
      state_value: 'executing',
      context: { cardId: card.id, active_reconstruction: terminalProcessorActive(card.id) },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    appendExecutorToolCall(projectRoot, card.id, 'run_command', { command: 'echo recovered', wait: true });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getStatus()).toMatchObject({ status: 'paused' });
    expect(store.read(card.id)).toMatchObject({ status: 'running' });
    expect(readToolCallStatuses(projectRoot, `executor:${card.id}`).map((record) => record.status)).toEqual(['pending']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining([`card:${card.id}`, `executor:${card.id}`, `processor:${card.id}`]));
  }));

  it('projects persisted planner terminal tool outcomes during startup recovery', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    store.setStatus(project.id, 'running');
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:project',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'project', active_reconstruction: cardActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'waiting_tool',
      context: { cardId: 'project', active_reconstruction: plannerWaitingActive('project', 'emit_result') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:project',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'project', active_reconstruction: processorActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    appendPlannerToolCall(projectRoot, 'project', 'emit_result', { status: 'blocked', summary: 'needs operator' });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(store.read(project.id)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'needs operator' } } });
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toEqual(expect.arrayContaining(['card:project', 'planner:project', 'processor:project']));
    expect(readToolCallStatuses(projectRoot, 'planner:project').map((record) => record.status)).toEqual(['pending', 'terminal_projected']);
    expect(readRecoveryDiagnostics(projectRoot)).toBeNull();
  }));

  it('projects paired planner done and reviewer pass outcomes during startup recovery', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    createDoneEvidence(store, project.id);
    store.setStatus(project.id, 'running');
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:project',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'project', active_reconstruction: cardActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'waiting_tool',
      context: { cardId: 'project', active_reconstruction: plannerWaitingActive('project', 'emit_result') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'reviewer:project',
      actor_kind: 'llm',
      state_value: 'waiting_tool',
      context: { cardId: 'project', active_reconstruction: reviewerWaitingActive('project', 'emit_result') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:project',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'project', active_reconstruction: processorActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    appendPlannerToolCall(projectRoot, 'project', 'emit_result', { status: 'done', summary: 'project done' });
    appendReviewerToolCall(projectRoot, 'project', { status: 'done', summary: 'review ok' });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(store.read(project.id)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'review ok' } } });
    expect(readToolCallStatuses(projectRoot).filter((record) => record.status === 'terminal_projected').map((record) => record.agent_id).sort()).toEqual(['planner:project', 'reviewer:project']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toEqual(expect.arrayContaining(['card:project', 'planner:project', 'processor:project', 'reviewer:project']));
  }));

  it('recovers activate_card waiting tool calls when child evidence is terminal', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = createProject(store);
    const child = createDoneEvidence(store, project.id);
    store.setStatus(project.id, 'running');
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:project',
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: 'project', active_reconstruction: cardActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:project',
      actor_kind: 'llm',
      state_value: 'waiting_tool',
      context: { cardId: 'project', active_reconstruction: plannerWaitingActive('project', 'activate_card') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:project',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'project', active_reconstruction: processorActive('project') },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    appendPlannerToolCall(projectRoot, 'project', 'activate_card', { card_id: child.id });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getStatus()).toMatchObject({ status: 'paused' });
    expect(store.read(project.id)).toMatchObject({ status: 'running', status_text: null });
    await eventually(() => expect(readToolCallStatuses(projectRoot, 'planner:project').map((record) => record.status)).toEqual(['pending', 'delivered']));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:project', 'planner:project', 'processor:project']));
  }));

  it('starts project work by executing the root CardActor', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: store,
      actorStore: store,
      provider: blockedPlannerProvider(),
      processRunner: testProcessRunner(projectRoot),
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.command).toMatchObject({ command: 'start_project', status: 'accepted' });
      expect(result.run).toMatchObject({ card_id: 'project', phase: 'pending', runtime_status: 'running', outcome: null });
    }
    await waitForRootRun(projectRoot, (run) => run.phase === 'blocked');
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:project', 'planner:project', 'processor:project', 'supervisor']));
  }));

  it('executes the project card through CardActor when actor dependencies are supplied', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const evidence = createDoneEvidence(store);
    const provider = doneProjectProvider(evidence.id);
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: store,
      actorStore: store,
      provider,
      processRunner: testProcessRunner(projectRoot),
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) expect(result.run).toMatchObject({ phase: 'pending', runtime_status: 'running', outcome: null });
    const terminal = await waitForRootRun(projectRoot, (run) => run.phase === 'completed');
    expect(terminal).toMatchObject({ phase: 'completed', runtime_status: 'stopped', outcome: { kind: 'completed', result: 'done' } });
    expect(store.read('project')).toMatchObject({ status: 'done', status_text: 'project reviewed', lifecycle: { result: { kind: 'done', summary: 'project reviewed' } } });
    expect(readToolCallStatuses(projectRoot).filter((record) => record.tool_name === 'emit_result' && record.status === 'terminal_projected').map((record) => record.agent_id).sort()).toEqual(['planner:project', 'reviewer:project']);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:project', 'planner:project', 'reviewer:project', 'processor:project', 'supervisor']));
  }));

  it('throws on startProject when the project card record is missing', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      actorStore: inertStore,
      provider: blockedPlannerProvider(),
      processRunner: testProcessRunner(projectRoot),
      now: () => '2026-06-12T00:00:00.000Z',
    });

    await expect(api.startProject('operator')).rejects.toThrow("Root card record 'project' is corrupt or missing");
  }));

  it('reconciles stale running root runs on startup', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const mutations = createRuntimeStateMutationPort(projectRoot);
    const command = mutations.apply({ kind: 'appendRuntimeCommand', commandKind: 'start_project', source: 'operator' });
    const stale = mutations.apply({
      kind: 'appendRuntimeRun',
      run: {
        kind: 'root',
        card_id: 'project',
        ownership: { kind: 'direct', source: 'project_root' },
        parent_run_id: null,
        command_id: command.command_id,
        activation_id: null,
        phase: 'pending',
        runtime_status: 'running',
        session_id: 'planner:project',
        finished_at: null,
        outcome: null,
      },
    });
    mutations.apply({ kind: 'patchRuntimeState', patch: { status: 'running' } });
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), processRunner: testProcessRunner(projectRoot), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(readRuntimeState(projectRoot)?.runtime_runs.find((run) => run.run_id === stale.run_id)).toMatchObject({ phase: 'failed', runtime_status: 'stopped', outcome: { kind: 'completed', result: 'failed', error: 'Runtime process restarted before this run completed.' } });
    expect(readRuntimeState(projectRoot)).toMatchObject({ status: 'stopped', active_card_run: null });
  }));

  it('stopProject cancels the active project run', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => new Promise<LlmCompleteResult>(() => undefined)) };
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: store,
      actorStore: store,
      provider,
      processRunner: testProcessRunner(projectRoot),
      now: () => '2026-06-12T00:00:00.000Z',
    });
    await api.startProject('operator');
    await eventually(() => expect(provider.completeTurn).toHaveBeenCalledTimes(1));

    const result = await api.stopProject('operator');

    expect(result).toEqual({
      success: true,
      command: expect.objectContaining({ command: 'stop_project', status: 'completed', source: 'operator' }),
      run: expect.objectContaining({ phase: 'cancelled', runtime_status: 'cancelled' }),
    });
    expect(api.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
  }));
});
