import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardLifecycleState, CardRecord } from '../../src/schemas/index.js';
import {
  commitExecutorParkedVerification,
  commitExecutorSuccess,
  commitPlannerBlocked,
  commitPlannerDone,
  commitReviewerPass,
  validateEvidenceCompleteness,
  validateGeneratedFiles,
  validateTerminalOverlay,
} from '../../src/runtime/terminal-commit/index.js';

const now = '2026-01-01T00:00:00.000Z';

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardLifecycleState);
  return {
    id: overrides.id ?? 'card-a',
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'project',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Card A',
    description: overrides.description ?? '',
    status: overrides.status ?? 'running',
    subtype: overrides.subtype ?? null,
    instructions_file: overrides.instructions_file ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'planner',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    version_seq: overrides.version_seq ?? 1,
    assigned_to: overrides.assigned_to ?? null,
    depends_on: overrides.depends_on ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    lifecycle,
    metrics: overrides.metrics ?? null,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    status_text: overrides.status_text ?? null,
    status_text_updated_at: overrides.status_text_updated_at ?? null,
    status_text_author_session_id: overrides.status_text_author_session_id ?? null,
    latest_self_report: overrides.latest_self_report ?? null,
    metadata: overrides.metadata ?? null,
    retries: overrides.retries ?? 0,
  };
}

function effects() {
  const transitions: Array<{ cardId: string; event: string; details: Record<string, unknown> }> = [];
  const patches: Array<{ cardId: string; patch: Partial<CardRecord> }> = [];
  return {
    transitions,
    patches,
    transitionCard: async (cardId: string, event: string, details: Record<string, unknown>) => {
      transitions.push({ cardId, event, details });
      return true;
    },
    updateCard: async (cardId: string, patch: Partial<CardRecord>) => {
      patches.push({ cardId, patch });
    },
  };
}

describe('terminal commit validators', () => {
  it('validates generated file existence and project-root safety', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-terminal-commit-'));
    try {
      writeFileSync(join(projectRoot, 'present.txt'), 'ok\n', 'utf8');
      expect(validateGeneratedFiles(projectRoot, ['present.txt', 'missing.txt', '../outside.txt', ''])).toEqual({
        valid: ['present.txt'],
        missing: ['missing.txt'],
        unsafe: ['../outside.txt', ''],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates done overlays by typed result discriminant', () => {
    expect(validateTerminalOverlay(card(), {
      status: 'done',
      result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked' },
      error: null,
      completed_at: now,
    } as never)).toEqual(expect.arrayContaining([
      expect.stringContaining('Invalid lifecycle state:'),
    ]));

    expect(validateTerminalOverlay(card(), {
      status: 'done',
      result: {
        kind: 'reviewer_pass',
        planning: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked' },
        review_summary: 'blocked planning reviewed',
        assessment_id: 'assessment-1',
      },
      error: null,
      completed_at: now,
    })).toEqual([]);
  });

  it('checks reviewer evidence completeness', () => {
    const goal = card({ id: 'goal-a', type: 'goal', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'planned' }, error: null, completed_at: null } });
    const result = validateEvidenceCompleteness({
      card: goal,
      evidenceCardIds: ['child-a', 'child-b'],
      readCard: (id) => id === 'child-a' ? card({ id, status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { ok: true }, generated_files: [], verified_at: now, latest_self_report: { result: 'done', outcome: 'done', summary: 'ok', status_text: 'done', at: now }, warnings: [] }, error: null, completed_at: now } }) : card({ id, status: 'active', lifecycle: { status: 'active', result: null, error: null, completed_at: null } }),
    });
    expect(result.semantically_complete).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "Reviewer cited non-complete evidence card 'child-b' with status 'active'.",
      "Reviewer cited card 'child-b' without durable result, artifact, or attachment evidence.",
    ]));
  });
});

describe('terminal commit functions', () => {
  it('commits executor needs_verification with error:null and completed_at:null', async () => {
    const fx = effects();
    const receipt = await commitExecutorParkedVerification({
      card: card(),
      goalId: 'goal-a',
      reason: 'fallback evidence needs human check',
      preservedResult: { output: true },
      fallbackReason: 'tool_failed',
      acceptedAt: now,
      statusText: 'Needs verification',
      effects: fx,
    });

    expect(receipt.lifecycle).toEqual(expect.objectContaining({ status: 'needs_verification', error: null, completed_at: null }));
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'needs_verification', lifecycle: expect.objectContaining({ status: 'needs_verification', error: null, completed_at: null }) }));
    expect(receipt.patch.lifecycle?.result).toEqual(receipt.result);
    expect(receipt.patch.lifecycle?.result).not.toHaveProperty('success');
    expect(fx.transitions[0]).toEqual(expect.objectContaining({ event: 'executor_partial_finish' }));
  });

  it('throws and does not write when a terminal transition is rejected', async () => {
    const fx = effects();
    fx.transitionCard = async () => false;

    await expect(commitExecutorSuccess({
      projectRoot: process.cwd(),
      card: card(),
      goalId: 'goal-a',
      executor: {},
      generatedFiles: [],
      acceptedAt: now,
      completedAt: now,
      summary: 'done',
      statusText: 'done',
      sessionId: 'executor-card-a',
      effects: fx,
    })).rejects.toThrow('Terminal commit transition was rejected.');
    expect(fx.patches).toEqual([]);
  });

  it('commits reviewer pass and clears stale card error', async () => {
    const fx = effects();
    const receipt = await commitReviewerPass({
      card: card({ id: 'goal-a', type: 'goal', status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'stale blocked reason', resume_reason: 'planner_blocked' }, error: 'stale blocked reason', completed_at: null } }),
      planning: { kind: 'planner_done', summary: 'planned' },
      reviewSummary: 'passed',
      assessmentId: 'assessment-1',
      completedAt: now,
      effects: fx,
    });

    expect(receipt.lifecycle.error).toBeNull();
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'done', lifecycle: expect.objectContaining({ status: 'done', error: null, completed_at: now }) }));
    expect(receipt.result).toEqual(expect.objectContaining({ kind: 'reviewer_pass', review_summary: 'passed' }));
  });

  it('rejects reviewer pass without typed planning context', async () => {
    const fx = effects();
    await expect(commitReviewerPass({
      card: card({ id: 'goal-a', type: 'goal', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }),
      planning: null,
      reviewSummary: 'passed',
      assessmentId: 'assessment-1',
      completedAt: now,
      effects: fx,
    })).rejects.toThrow("Cannot commit reviewer pass for card 'goal-a' without typed planner lifecycle context.");
  });

  it('rejects planner done for parent goal and commits it for planning-only cards', async () => {
    const fx = effects();
    await expect(commitPlannerDone({
      card: card({ id: 'goal-a', type: 'goal' }),
      summary: 'done',
      completedAt: now,
      effects: fx,
    })).rejects.toThrow("Planner done cannot be terminal for parent card type 'goal'.");

    const receipt = await commitPlannerDone({
      card: card({ id: 'doc-a', type: 'doc' }),
      summary: 'doc planning done',
      completedAt: now,
      effects: fx,
    });
    expect(receipt.lifecycle.result).toEqual({ kind: 'planner_done', summary: 'doc planning done' });
  });

  it('commits planner blocked with only typed lifecycle result', async () => {
    const fx = effects();
    const receipt = await commitPlannerBlocked({
      card: card({ id: 'goal-a', type: 'goal' }),
      blockedReason: 'token budget',
      resumeReason: 'planner_context_length_exceeded',
      effects: fx,
    });

    expect(receipt.result).toEqual({ kind: 'planner_blocked', blocked_reason: 'token budget', resume_reason: 'planner_context_length_exceeded', blocker_cause: 'token_budget_exceeded' });
    expect(receipt.patch).toEqual(expect.objectContaining({
      status: 'blocked',
      lifecycle: { status: 'blocked', error: 'token budget', completed_at: null, result: { kind: 'planner_blocked', blocked_reason: 'token budget', resume_reason: 'planner_context_length_exceeded', blocker_cause: 'token_budget_exceeded' } },
    }));
    expect(fx.transitions[0]).toEqual(expect.objectContaining({ event: 'block' }));
  });

  it('rejects executor success when generated files are missing or unsafe', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-terminal-commit-missing-'));
    try {
      await expect(commitExecutorSuccess({
        projectRoot,
        card: card(),
        goalId: 'goal-a',
        executor: {},
        generatedFiles: ['missing.txt'],
        acceptedAt: now,
        completedAt: now,
        summary: 'done',
        statusText: 'done',
        sessionId: null,
        effects: effects(),
      })).rejects.toThrow("Generated file claim does not exist: 'missing.txt'.");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
