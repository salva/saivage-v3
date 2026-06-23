import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { buildActorRuntimeReadModel } from '../../src/application/read-models/actor-runtime-read-model.js';
import { RuntimeSupervisorActor, saveActorSnapshot } from '../../src/runtime/actors/index.js';

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
      state_value: 'running',
      context: { privateField: 'not projected' },
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toEqual({
      pauseMode: 'paused',
      cards: [{ cardId: 'T-1', actorState: 'running' }],
      agents: [{ agentId: 'executor:T-1', agentPhase: 'running' }],
      diagnostics: [],
    });
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
      diagnostics: ['supervisor snapshot is missing mode region'],
    });
  }));

  it('maps unknown actor phases to diagnostics instead of exposing raw state values', () => withTempProject((projectRoot) => {
    saveActorSnapshot(projectRoot, {
      actor_id: 'card:G-unknown',
      actor_kind: 'card',
      state_value: { nested: 'xstate-node' },
      context: {},
      updated_at: new Date().toISOString(),
    });
    saveActorSnapshot(projectRoot, {
      actor_id: 'planner:G-unknown',
      actor_kind: 'llm',
      state_value: 'waiting_for_tool',
      context: {},
      updated_at: new Date().toISOString(),
    });

    expect(buildActorRuntimeReadModel(projectRoot)).toMatchObject({
      cards: [{ cardId: 'G-unknown', actorState: 'unknown' }],
      agents: [{ agentId: 'planner:G-unknown', agentPhase: 'unknown' }],
      diagnostics: [
        "card actor 'card:G-unknown' has unknown state '[object Object]'",
        "agent actor 'planner:G-unknown' has unknown phase 'waiting_for_tool'",
      ],
    });
  }));
});
