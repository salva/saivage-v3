import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildActorRuntimeReadModel } from '../../src/application/read-models/actor-runtime-read-model.js';
import { RuntimeSupervisorActor, buildActorRecoveryPlan, saveActorSnapshot, writeRecoveryDiagnostics } from '../../src/runtime/actors/index.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardStatus } from '../../src/schemas/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-read-model-'));
  initProjectTree(projectRoot);
  const result = fn(projectRoot);
  if (result instanceof Promise) {
    return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  }
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function createCardWithStatus(store: CardStore, status: CardStatus) {
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: `card-${status}`, brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  if (status === 'backlog') return card;
  if (status === 'changed') return store.commitTerminalLifecyclePatch(card.id, { status, lifecycle: { status, result: null, error: null, completed_at: null } });
  if (status === 'done') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
  if (status === 'failed') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-06-12T00:00:00.000Z' } });
  if (status === 'blocked') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'blocked' }, error: 'blocked', completed_at: null } });
  if (status === 'needs_verification') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'executor_needs_verification', reason: 'verify', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'verify', status_text: 'verify', at: '2026-06-12T00:00:00.000Z' } }, error: null, completed_at: null } });
  return store.setStatus(card.id, status);
}

describe('actor runtime read model', () => {
  it('projects supervisor, card actor, and LLM actor snapshots without raw state details', () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const card = new CardStore(projectRoot).create({ type: 'code', parent: 'project', depth: 1, title: 'Task', brief: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();
    await eventually(() => { expect(supervisor.mode).toBe('running'); });
    supervisor.pause();
    await eventually(() => { expect(supervisor.mode).toBe('paused'); });
    saveActorSnapshot(projectRoot, {
      actor_id: `card:${card.id}`,
      actor_kind: 'card',
      state_value: 'running',
      context: { privateField: 'not projected' },
      updated_at: new Date().toISOString(),
    });
    saveActorSnapshot(projectRoot, {
      actor_id: `executor:${card.id}`,
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { privateField: 'not projected' },
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toEqual({
      pauseMode: 'paused',
      activeWork: 'none',
      cards: [{ cardId: card.id, actorState: 'running' }],
      agents: [{ agentId: `executor:${card.id}`, role: 'executor', cardId: card.id, phase: 'calling_provider' }],
      diagnostics: [],
      recovery: null,
    });
  }));

  it('projects public card state from card store status, not actor lifecycle state', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const cardStates: CardStatus[] = ['backlog', 'changed', 'blocked', 'failed', 'done', 'running', 'cancelled', 'needs_verification'];
    const llmStates = ['idle', 'calling_provider', 'waiting_tool'];
    cardStates.forEach((state) => {
      const card = createCardWithStatus(store, state);
      saveActorSnapshot(projectRoot, { actor_id: `card:${card.id}`, actor_kind: 'card', state_value: state === 'running' ? 'running' : state === 'cancelled' ? 'cancelled' : 'parked', context: {}, updated_at: new Date().toISOString() });
    });
    llmStates.forEach((state) => saveActorSnapshot(projectRoot, { actor_id: `planner:${state}`, actor_kind: 'llm', state_value: state, context: {}, updated_at: new Date().toISOString() }));

    const model = buildActorRuntimeReadModel(projectRoot);

    expect(model.diagnostics).toEqual([]);
    expect(model.cards.map((card) => card.actorState).sort()).toEqual([...cardStates].sort());
    expect(model.agents.map((agent) => agent.phase).sort()).toEqual(['calling_provider', 'idle', 'waiting_for_tool']);
  }));

  it('projects needs_verification from the card store, not the actor snapshot lifecycle state', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const card = createCardWithStatus(new CardStore(projectRoot), 'needs_verification');
    saveActorSnapshot(projectRoot, { actor_id: `card:${card.id}`, actor_kind: 'card', state_value: 'parked', context: {}, updated_at: new Date().toISOString() });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({
      cards: [{ cardId: card.id, actorState: 'needs_verification' }],
      diagnostics: [],
    });
  }));

  it('accepts current supervisor modes without unknown-mode diagnostics', () => withTempProject((projectRoot) => {
    for (const [mode, expected] of [['idle', 'idle'], ['running', 'running'], ['paused', 'paused']] as const) {
      saveActorSnapshot(projectRoot, { actor_id: 'supervisor', actor_kind: 'supervisor', state_value: { mode, work: 'ready' }, context: {}, updated_at: new Date().toISOString() });
      expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: expected, activeWork: 'none', diagnostics: [] });
    }
  }));

  it('reports unknown supervisor snapshot shape as diagnostics', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'supervisor',
      actor_kind: 'supervisor',
      state_value: 'running',
      context: {},
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({
      pauseMode: 'unknown',
      activeWork: 'unknown',
      diagnostics: ['supervisor snapshot is missing mode region', 'supervisor snapshot is missing active work region'],
    });
  }));

  it('maps idle supervisor snapshots to idle runtime availability', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'supervisor',
      actor_kind: 'supervisor',
      state_value: { mode: 'idle', work: 'ready' },
      context: {},
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: 'idle', activeWork: 'none', diagnostics: [], recovery: null });
  }));

  it('projects sanitized recovery diagnostics', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'supervisor',
      actor_kind: 'supervisor',
      state_value: { mode: 'running', work: 'ready' },
      context: { providerPayload: 'not projected' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    const model = buildActorRuntimeReadModel(projectRoot);

    expect(model.recovery).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: [expect.objectContaining({ actorId: 'supervisor', severity: 'warning' })],
      actions: [expect.objectContaining({ actorId: 'supervisor', kind: 'discarded_supervisor', action: 'discard_stale_supervisor' })],
    });
    expect(JSON.stringify(model.recovery)).not.toContain('not projected');
  }));
});
