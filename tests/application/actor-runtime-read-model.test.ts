import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildActorRuntimeReadModel } from '../../src/application/read-models/actor-runtime-read-model.js';
import { buildActorRecoveryPlan, saveActorSnapshot, writeRecoveryDiagnostics } from '../../src/runtime/actors/index.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardStatus } from '../../src/schemas/index.js';
import { createRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { runtimeStatePath } from '../../src/runtime/state.js';

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

function createCardWithStatus(store: CardStore, status: CardStatus) {
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: `card-${status}`, brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  if (status === 'backlog') return card;
  if (status === 'changed') return store.commitTerminalLifecyclePatch(card.id, { status, lifecycle: { status, result: null, error: null, completed_at: null } });
  if (status === 'done') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
  if (status === 'failed') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-06-12T00:00:00.000Z' } });
  if (status === 'blocked') return store.repairTerminalLifecycle(card.id, { status, lifecycle: { status, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'blocked' }, error: 'blocked', completed_at: null } });
  return store.setStatus(card.id, status);
}

function llmActive(cardId: string): Record<string, unknown> {
  const inputId = `planner:${cardId}:1`;
  return { schema_version: 1, kind: 'llm_turn', agent_id: `planner:${cardId}`, role: 'planner', card_id: cardId, input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, provider_call_id: `planner:${cardId}:${inputId}`, waiting_tool_call: null, delivered_tool_call_ids: [], tool_delivery_counter: 0, started_at: '2026-06-12T00:00:00.000Z' };
}

function cardActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'card_activation', card_id: cardId, processor_actor_id: `processor:${cardId}`, caller: { kind: 'root' }, started_at: '2026-06-12T00:00:00.000Z' };
}

describe('actor runtime read model', () => {
  it('projects runtime status, card actor, and LLM actor snapshots without raw state details', () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const card = new CardStore(projectRoot).create({ type: 'code', parent: 'project', depth: 1, title: 'Task', brief: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    createRuntimeStateMutationPort(projectRoot).apply({ kind: 'patchRuntimeState', patch: { status: 'paused' } });
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
    const cardStates: CardStatus[] = ['backlog', 'changed', 'blocked', 'failed', 'done', 'running', 'cancelled'];
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

  it('accepts current runtime statuses without unknown-mode diagnostics', () => withTempProject((projectRoot) => {
    for (const [status, expected] of [['stopped', 'idle'], ['running', 'running'], ['paused', 'paused']] as const) {
      createRuntimeStateMutationPort(projectRoot).apply({ kind: 'patchRuntimeState', patch: { status } });
      expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: expected, activeWork: 'none', diagnostics: [] });
    }
  }));

  it('maps error runtime status to unknown runtime availability', () => withTempProject((projectRoot) => {
    createRuntimeStateMutationPort(projectRoot).apply({ kind: 'patchRuntimeState', patch: { status: 'error' } });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({
      pauseMode: 'unknown',
      activeWork: 'unknown',
      diagnostics: [],
    });
  }));

  it('maps missing and stopped runtime status to runtime availability', () => withTempProject((projectRoot) => {
    rmSync(runtimeStatePath(projectRoot), { force: true });
    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: 'unknown', activeWork: 'unknown', diagnostics: [], recovery: null });

    createRuntimeStateMutationPort(projectRoot).apply({ kind: 'patchRuntimeState', patch: { status: 'stopped' } });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({ pauseMode: 'idle', activeWork: 'none', diagnostics: [], recovery: null });
  }));

  it('projects sanitized recovery diagnostics', () => withTempProject((projectRoot) => {
    const card = new CardStore(projectRoot).create({ type: 'code', parent: 'project', depth: 1, title: 'Task', brief: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    saveActorSnapshot(projectRoot, {
      actor_id: `card:${card.id}`,
      actor_kind: 'card',
      state_value: 'running',
      context: { cardId: card.id, active_reconstruction: cardActive(card.id), providerPayload: 'not projected' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    saveActorSnapshot(projectRoot, {
      actor_id: `planner:${card.id}`,
      actor_kind: 'llm',
      state_value: 'calling_provider',
      context: { cardId: card.id, active_reconstruction: llmActive(card.id), providerPayload: 'not projected' },
      updated_at: '2026-06-12T00:00:00.000Z',
    });
    writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    const model = buildActorRuntimeReadModel(projectRoot);

    expect(model.recovery).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: expect.arrayContaining([expect.objectContaining({ actorId: `planner:${card.id}`, severity: 'warning' })]),
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: `card:${card.id}`, kind: 'active_card', action: 'diagnose_active_card' }),
        expect.objectContaining({ actorId: `planner:${card.id}`, kind: 'active_llm', action: 'diagnose_active_llm' }),
      ]),
    });
    expect(JSON.stringify(model.recovery)).not.toContain('not projected');
    expect(JSON.stringify(model.recovery)).not.toContain('discarded_supervisor');
  }));
});
