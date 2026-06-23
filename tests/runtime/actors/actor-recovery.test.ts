import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildActorRecoveryPlan,
  cleanupHandledRecoverySnapshots,
  readRecoveryDiagnostics,
  readActorSnapshots,
  recoveryDiagnosticsPath,
  removeActorSnapshot,
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
      { processId: 'build-1', action: 'abandon_running_process' },
      { processId: 'done-1', action: 'none' },
    ]);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:T-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' }),
    ]));
  }));

  it('does not treat parked card snapshots as active unless public status is running', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-backlog', 'card', 'backlog', { cardId: 'G-backlog' });
    saveSnapshot(projectRoot, 'card:G-blocked', 'card', 'blocked', { cardId: 'G-blocked' });
    saveSnapshot(projectRoot, 'card:G-changed', 'card', 'changed', { cardId: 'G-changed', publicStatus: 'running' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.cards).toMatchObject([
      { cardId: 'G-backlog', active: false },
      { cardId: 'G-blocked', active: false },
      { cardId: 'G-changed', active: true },
    ]);
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

  it('diagnoses active LLM snapshots without a concrete recovery action', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1' });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'running', { cardId: 'G-1' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
    ]));
  }));

  it('diagnoses active cards without active processor, LLM, or active child evidence', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-stranded', 'card', 'running', { cardId: 'G-stranded' });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn(() => []) });

    expect(plan.diagnostics).toEqual([expect.objectContaining({ actorId: 'card:G-stranded', severity: 'warning' })]);
    expect(plan.diagnostics[0].message).toContain('no active processor');
  }));

  it('does not diagnose active cards as stranded when processor or active child evidence exists', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-processor', 'card', 'running', { cardId: 'G-processor' });
    saveSnapshot(projectRoot, 'processor:G-processor', 'processor', 'planning', { cardId: 'G-processor' });
    saveSnapshot(projectRoot, 'card:G-parent', 'card', 'running', { cardId: 'G-parent' });
    saveSnapshot(projectRoot, 'card:G-child', 'card', 'running', { cardId: 'G-child' });
    const children = new Map<string, string[]>([['G-parent', ['G-child']]]);

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn((cardId: string) => children.get(cardId) ?? []) });

    expect(plan.diagnostics.filter((diagnostic) => diagnostic.message.includes('no active processor')).map((diagnostic) => diagnostic.actorId)).toEqual(['card:G-child']);
  }));

  it('diagnoses ambiguous active card states', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-old', 'card', 'planning', { cardId: 'G-old', publicStatus: 'running' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:G-old', severity: 'warning' }),
    ]));
    expect(plan.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain("ambiguous state 'planning'");
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
      schema_version: 1,
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

  it('clears stale recovery diagnostics when recovery work is clean', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z')).not.toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(true);

    removeActorSnapshot(projectRoot, 'process:build-1');
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:01.000Z')).toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(false);
  }));

  it('diagnoses non-idle supervisor snapshots as discarded on startup', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'supervisor', 'supervisor', { mode: 'running', work: 'model_invocation_active' }, { projectRoot, activeProviderCallId: 'call-1' });

    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      diagnostics: [expect.objectContaining({ actorId: 'supervisor', severity: 'warning' })],
      actions: [expect.objectContaining({ actorId: 'supervisor', kind: 'discarded_supervisor', action: 'discard_stale_supervisor' })],
    });
  }));

  it('persists running process abandonment diagnostics instead of reconciliation requests', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:kill-1', 'process', 'killing', { processId: 'kill-1' });

    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'process:build-1', kind: 'running_process', action: 'abandon_running_process', processId: 'build-1' }),
        expect.objectContaining({ actorId: 'process:kill-1', kind: 'running_process', action: 'abandon_running_process', processId: 'kill-1' }),
      ]),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' }),
        expect.objectContaining({ actorId: 'process:kill-1', severity: 'warning' }),
      ]),
    });
    const messages = written?.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ?? '';
    expect(messages).toContain('abandoned on startup');
    expect(messages).not.toContain('requires live process reconciliation');
  }));

  it('cleans up only abandoned process snapshots after diagnostics are written', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:done-1', 'process', 'settled', { processId: 'done-1' });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1' });
    const plan = buildActorRecoveryPlan(projectRoot);
    writeRecoveryDiagnostics(projectRoot, plan, '2026-06-12T00:00:00.000Z');

    cleanupHandledRecoverySnapshots(projectRoot, plan);

    expect(readRecoveryDiagnostics(projectRoot)?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'process:build-1', action: 'abandon_running_process' }),
    ]));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:G-1', 'process:done-1']));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toContain('process:build-1');
  }));
});
