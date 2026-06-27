import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildActorRuntimeReadModel } from '../../src/application/read-models/actor-runtime-read-model.js';
import { RuntimeSupervisorActor, buildActorRecoveryPlan, cardActorStates, saveActorSnapshot, writeRecoveryDiagnostics } from '../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-read-model-'));
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

describe('actor runtime read model', () => {
  it('projects supervisor, card actor, and LLM actor snapshots without raw state details', () => withTempProject(async (projectRoot) => {
    const supervisor = new RuntimeSupervisorActor();
    supervisor.start();
    supervisor.initialize(projectRoot);
    supervisor.run();
    await eventually(() => { expect(supervisor.mode).toBe('running'); });
    expect(supervisor.requestProviderCall('provider-call-1')).toBe(true);
    supervisor.pause();
    await eventually(() => { expect(supervisor.mode).toBe('paused'); });
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:T-1',
      actor_kind: 'card',
      state_value: 'running',
      context: { privateField: 'not projected' },
      updated_at: new Date().toISOString(),
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'executor:T-1',
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { privateField: 'not projected' },
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toEqual({
      pauseMode: 'paused',
      activeWork: 'model_invocation',
      cards: [{ cardId: 'T-1', actorState: 'running' }],
      agents: [{ agentId: 'executor:T-1', role: 'executor', cardId: 'T-1', phase: 'calling_provider' }],
      diagnostics: [],
      recovery: null,
    });
  }));

  it('accepts current actor states without diagnostics', () => withTempProject((projectRoot) => {
    const cardStates = cardActorStates;
    const llmStates = ['idle', 'calling_provider', 'waiting_tool'];
    cardStates.forEach((state) => saveActorSnapshot(projectRoot, { actor_id: `card:${state}`, actor_kind: 'card', state_value: state, context: {}, updated_at: new Date().toISOString() }));
    llmStates.forEach((state) => saveActorSnapshot(projectRoot, { actor_id: `planner:${state}`, actor_kind: 'llm', state_value: state, context: {}, updated_at: new Date().toISOString() }));

    const model = buildActorRuntimeReadModel(projectRoot);

    expect(model.diagnostics).toEqual([]);
    expect(model.cards.map((card) => card.actorState).sort()).toEqual([...cardStates].sort());
    expect(model.agents.map((agent) => agent.phase).sort()).toEqual(['calling_provider', 'idle', 'waiting_for_tool']);
  }));

  it('uses the shared card actor vocabulary for needs_verification snapshots', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, { actor_id: 'card:needs-check', actor_kind: 'card', state_value: 'needs_verification', context: {}, updated_at: new Date().toISOString() });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({
      cards: [{ cardId: 'needs-check', actorState: 'needs_verification' }],
      diagnostics: [],
    });
  }));

  it('accepts current supervisor modes without unknown-mode diagnostics', () => withTempProject((projectRoot) => {
    for (const [mode, expected] of [['idle', 'idle'], ['running', 'running'], ['paused', 'paused'], ['shutting_down', 'stopping']] as const) {
      saveActorSnapshot(projectRoot, { actor_id: 'supervisor', actor_kind: 'supervisor', state_value: { mode, work: mode === 'shutting_down' ? 'shutdown_active' : 'ready' }, context: {}, updated_at: new Date().toISOString() });
      expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: expected, activeWork: mode === 'shutting_down' ? 'shutdown' : 'none', diagnostics: [] });
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
      actor_id: 'process:build-1',
      actor_kind: 'process',
      state_value: 'running',
      context: { providerPayload: 'not projected' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    const model = buildActorRuntimeReadModel(projectRoot);

    expect(model.recovery).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: [expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' })],
      actions: [expect.objectContaining({ actorId: 'process:build-1', kind: 'running_process', action: 'abandon_running_process', processId: 'build-1' })],
    });
    expect(JSON.stringify(model.recovery)).not.toContain('not projected');
  }));
});
