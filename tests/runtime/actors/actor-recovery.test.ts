import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildActorRecoveryPlan,
  readRecoveryDiagnostics,
  recoveryDiagnosticsPath,
  saveActorSnapshot,
  writeRecoveryDiagnostics,
} from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-recovery-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function saveSnapshot(projectRoot: string, actorId: string, actorKind: 'supervisor' | 'card' | 'llm' | 'process' | 'processor', stateValue: unknown, context: Record<string, unknown> = {}): void {
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
    expect(buildActorRecoveryPlan(projectRoot)).toEqual({ supervisor: null, cards: [], llms: [], processors: [], processes: [], diagnostics: [] });
  }));

  it('builds a deterministic plan for supervisor, active goal card, and planner LLM snapshots', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'running', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'supervisor', 'supervisor', { mode: 'running', work: 'ready' }, { projectRoot });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'planning', { cardId: 'G-1', publicStatus: 'running' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.supervisor?.actor_id).toBe('supervisor');
    expect(plan.cards).toMatchObject([{ cardId: 'G-1', active: true }]);
    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-1', role: 'planner', cardId: 'G-1', active: true, action: 'none' }]);
    expect(plan.processors).toEqual([]);
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
    expect(plan.diagnostics).toEqual([expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' })]);
  }));

  it('classifies processor snapshots and active LLM recovery actions', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'processor:G-1', 'processor', 'planning', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'reviewer:G-1', 'llm', 'waiting_tool', { cardId: 'G-1' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.processors).toMatchObject([{ actorId: 'processor:G-1', cardId: 'G-1', active: true }]);
    expect(plan.llms).toMatchObject([
      { actorId: 'planner:G-1', action: 'abandon_provider_call', active: true },
      { actorId: 'reviewer:G-1', action: 'resume_tool_wait', active: true },
    ]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'processor:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'reviewer:G-1', severity: 'info' }),
    ]);
  }));

  it('allows an active LLM snapshot when the owner card exists in the domain reader', () => withTempProject((projectRoot) => {
    const cards = new Map<string, { id: string; type: string }>([['G-domain', { id: 'G-domain', type: 'goal' }]]);
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

  it('persists sanitized recovery diagnostics only when recovery work exists', () => withTempProject((projectRoot) => {
    expect(readRecoveryDiagnostics(projectRoot)).toBeNull();
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z')).toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(false);

    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', publicStatus: 'running', secretLike: 'not persisted' });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', providerPayload: 'not persisted' });
    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: [expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' })],
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'card:G-1', kind: 'active_card', cardId: 'G-1' }),
        expect.objectContaining({ actorId: 'planner:G-1', kind: 'active_llm', cardId: 'G-1' }),
        expect.objectContaining({ actorId: 'planner:G-1', kind: 'llm_recovery_action', action: 'abandon_provider_call', cardId: 'G-1' }),
      ]),
    });
    expect(readRecoveryDiagnostics(projectRoot)).toEqual(written);
    expect(JSON.stringify(readRecoveryDiagnostics(projectRoot))).not.toContain('not persisted');
  }));
});
