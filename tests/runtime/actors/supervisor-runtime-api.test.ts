import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { createSupervisorRuntimeApi, readActorSnapshots, readRecoveryDiagnostics, saveActorSnapshot, SupervisorRuntimeApi, type CardActorStorePort, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { actorToolCallStatusesPath, appendToolCallStatus } from '../../../src/runtime/actors/index.js';
import type { CardRecord } from '../../../src/schemas/index.js';

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

function createProject(store: CardStore): CardRecord {
  return store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
}

function createDoneEvidence(store: CardStore, parent = 'project'): CardRecord {
  const card = store.create({ type: 'goal', parent, depth: 1, title: 'evidence', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  return store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'evidence done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
}

const inertStore: CardActorStorePort = {
  read: () => null,
  setStatus: () => { throw new Error('Unexpected setStatus call.'); },
  commitTerminalLifecyclePatch: () => { throw new Error('Unexpected commitTerminalLifecyclePatch call.'); },
};

function blockedPlannerProvider(): LLMProviderPort {
  return { completeTurn: jest.fn(async () => ({ kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked', blocked_reason: 'waiting for operator', summary: 'waiting for operator' }) } }] })) };
}

function doneProjectProvider(evidenceId: string): LLMProviderPort {
  return { completeTurn: jest.fn(async (input: LlmInvocationInput) => input.role === 'reviewer'
    ? { kind: 'tool_calls' as const, tool_calls: [{ id: 'reviewer-result-1', type: 'function' as const, function: { name: 'emit_reviewer_result', arguments: JSON.stringify({ assessment: { result: 'pass', summary: 'project reviewed', achieved: ['project completed'], issues: [], evidence_card_ids: [evidenceId] } }) } }] }
    : { kind: 'tool_calls' as const, tool_calls: [{ id: 'planner-result-1', type: 'function' as const, function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'done', summary: 'project completed' }) } }] }) };
}

describe('SupervisorRuntimeApi', () => {
  it('implements start, pause, resume, status, and shutdown through RuntimeSupervisorActor', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({ projectRoot, actorStore: store, provider: blockedPlannerProvider(), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false, currentCardId: null });
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'idle', paused: false });

    await api.startProject('operator');
    expect(api.getStatus()).toMatchObject({ status: 'running', paused: false, currentCardId: 'project' });
    api.pause();
    expect(api.getStatus()).toMatchObject({ status: 'paused', paused: true, currentCardId: 'project' });
    api.resume();
    expect(api.getStatus()).toMatchObject({ status: 'running', paused: false, currentCardId: 'project' });
    await api.shutdown();

    expect(readActorSnapshots(projectRoot).some((item) => item.actor_id === 'supervisor')).toBe(true);
  }));

  it('captures the actor recovery plan before starting the supervisor', async () => withTempProject(async (projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-recover',
      actor_kind: 'card',
      state_value: 'planning',
      context: { cardId: 'G-recover', publicStatus: 'running' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-recover',
      actor_kind: 'llm',
      state_value: 'running',
      context: { cardId: 'G-recover' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: inertStore, provider: blockedPlannerProvider(), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getRecoveryPlan()).toMatchObject({
      cards: [{ cardId: 'G-recover', active: true }],
      llms: [{ actorId: 'planner:G-recover', active: true }],
    });
  }));

  it('persists startup recovery diagnostics for active actors without resuming them', async () => withTempProject(async (projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-recover',
      actor_kind: 'card',
      state_value: 'planning',
      context: { cardId: 'G-recover', publicStatus: 'running' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-recover',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: 'G-recover' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'processor:G-recover',
      actor_kind: 'processor',
      state_value: 'planning',
      context: { cardId: 'G-recover' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'process:build-1',
      actor_kind: 'process',
      state_value: 'running',
      context: { processId: 'build-1' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: inertStore, provider: blockedPlannerProvider(), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(api.getStatus()).toMatchObject({ status: 'idle', currentCardId: null });
    expect(api.getRecoveryPlan()).toMatchObject({
      cards: [{ cardId: 'G-recover', active: true }],
      llms: [{ actorId: 'planner:G-recover', action: 'abandon_provider_call', active: true }],
      processors: [{ actorId: 'processor:G-recover', active: true }],
      processes: [{ processId: 'build-1', action: 'abandon_running_process' }],
    });
    expect(readRecoveryDiagnostics(projectRoot)).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ actorId: 'planner:G-recover', severity: 'warning' }),
        expect.objectContaining({ actorId: 'processor:G-recover', severity: 'warning' }),
        expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'card:G-recover', kind: 'active_card', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'planner:G-recover', kind: 'active_llm', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'planner:G-recover', kind: 'llm_recovery_action', action: 'abandon_provider_call', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'processor:G-recover', kind: 'active_processor', cardId: 'G-recover' }),
        expect.objectContaining({ actorId: 'process:build-1', kind: 'running_process', action: 'abandon_running_process', processId: 'build-1' }),
      ]),
    });
  }));

  it('abandons stale pending tool calls during startup recovery', async () => withTempProject(async (projectRoot) => {
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
    const api = new SupervisorRuntimeApi({ projectRoot, actorStore: inertStore, provider: blockedPlannerProvider(), now: () => '2026-06-12T00:00:00.000Z' });

    await api.start();

    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-stale')).map((entry) => entry.status)).toEqual(['pending', 'abandoned']);
    expect(readJsonl(actorToolCallStatusesPath(projectRoot, 'planner:G-delivered')).map((entry) => entry.status)).toEqual(['pending', 'delivered']);
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
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.command).toMatchObject({ command: 'start_project', status: 'completed', command_id: 'runtime-command-1' });
      expect(result.intent).toEqual({ status: 'running', updated_at: '2026-06-12T00:00:00.000Z', source_command_id: 'runtime-command-1', reason: null });
      expect(result.run).toMatchObject({ run_id: 'runtime-run-1', card_id: 'project', phase: 'blocked', runtime_status: 'running', outcome: { kind: 'blocked', error: 'waiting for operator' } });
    }
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
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) expect(result.run).toMatchObject({ phase: 'completed', runtime_status: 'idle', outcome: { kind: 'completed', result: 'done' } });
    expect(store.read('project')).toMatchObject({ status: 'done', status_text: 'project reviewed', lifecycle: { result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'project completed' } } } });
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:project', 'planner:project', 'reviewer:project', 'processor:project', 'supervisor']));
  }));

  it('rejects startProject when the project card is missing', async () => withTempProject(async (projectRoot) => {
    const api = createSupervisorRuntimeApi({
      projectRoot,
      actorStore: inertStore,
      provider: blockedPlannerProvider(),
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('runtime_project_card_missing');
  }));

  it('stopProject cancels the active project run and returns a stopped intent', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    createProject(store);
    const api = createSupervisorRuntimeApi({
      projectRoot,
      rootCards: store,
      actorStore: store,
      provider: blockedPlannerProvider(),
      now: () => '2026-06-12T00:00:00.000Z',
    });
    await api.startProject('operator');

    const result = await api.stopProject('operator');

    expect(result).toEqual({
      success: true,
      command: expect.objectContaining({ command: 'stop_project', status: 'completed', source: 'operator' }),
      intent: { status: 'stopped', updated_at: '2026-06-12T00:00:00.000Z', source_command_id: 'runtime-command-2', reason: 'runtime_project_cancelled' },
      run: expect.objectContaining({ phase: 'cancelled', runtime_status: 'cancelled' }),
    });
    expect(api.getStatus()).toMatchObject({ status: 'idle', currentCardId: null });
  }));
});
