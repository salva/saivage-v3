import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildActorRecoveryPlan,
  saveActorSnapshot,
  type XStateChildCard,
} from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-recovery-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function saveSnapshot(projectRoot: string, actorId: string, actorKind: 'supervisor' | 'card' | 'llm' | 'process', stateValue: unknown, context: Record<string, unknown> = {}): void {
  saveActorSnapshot(projectRoot, {
    actor_id: actorId,
    actor_kind: actorKind,
    state_value: stateValue,
    context,
    updated_at: '2026-06-12T00:00:00.000Z',
  });
}

describe('actor recovery plan', () => {
  it('builds an empty plan when no actor snapshots exist', () => withTempProject((projectRoot) => {
    expect(buildActorRecoveryPlan(projectRoot)).toEqual({ supervisor: null, cards: [], llms: [], processes: [] });
  }));

  it('builds a deterministic plan for supervisor, active goal card, and planner LLM snapshots', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'running', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'supervisor', 'supervisor', { mode: 'running', work: 'ready' }, { projectRoot });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'planning', { cardId: 'G-1', publicStatus: 'running' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.supervisor?.actor_id).toBe('supervisor');
    expect(plan.cards).toMatchObject([{ cardId: 'G-1', active: true }]);
    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-1', role: 'planner', cardId: 'G-1', active: true }]);
    expect(plan.processes).toEqual([]);
  }));

  it('includes terminal executor and process snapshots with reconciliation requirements', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:T-1', 'card', 'executing', { cardId: 'T-1', publicStatus: 'running' });
    saveSnapshot(projectRoot, 'executor:T-1', 'llm', 'done', { cardId: 'T-1' });
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:done-1', 'process', 'done', { processId: 'done-1' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.llms).toMatchObject([{ actorId: 'executor:T-1', role: 'executor', cardId: 'T-1', active: false }]);
    expect(plan.processes).toMatchObject([
      { processId: 'build-1', requiresReconciliation: true },
      { processId: 'done-1', requiresReconciliation: false },
    ]);
  }));

  it('allows an active LLM snapshot when the owner card exists in the domain reader', () => withTempProject((projectRoot) => {
    const cards = new Map<string, XStateChildCard>([['G-domain', { id: 'G-domain', type: 'goal' }]]);
    saveSnapshot(projectRoot, 'planner:G-domain', 'llm', 'running', { cardId: 'G-domain' });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn((cardId: string) => cards.get(cardId) ?? null) });

    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-domain', cardId: 'G-domain', active: true }]);
  }));

  it('throws on orphan active LLM snapshots without a snapshot or domain card owner', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-orphan', 'llm', 'running', { cardId: 'G-orphan' });

    expect(() => buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null) })).toThrow(
      "Cannot recover active LLM actor 'planner:G-orphan': owner card 'G-orphan' was not found.",
    );
  }));
});
