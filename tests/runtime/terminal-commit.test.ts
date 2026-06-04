import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardRecord } from '../../src/schemas/index.js';
import {
  commitExecutorParkedVerification,
  commitExecutorSuccess,
  commitPlannerDone,
  commitReviewerPass,
  validateEvidenceCompleteness,
  validateGeneratedFiles,
  validateTerminalOverlay,
} from '../../src/runtime/terminal-commit/index.js';

const now = '2026-01-01T00:00:00.000Z';

function card(overrides: Partial<CardRecord> = {}): CardRecord {
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
    blocks: overrides.blocks ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    result: overrides.result ?? null,
    metrics: overrides.metrics ?? null,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    error: overrides.error ?? null,
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

  it('detects stale terminal contradictions in done overlays', () => {
    expect(validateTerminalOverlay(card(), {
      status: 'done',
      result: { parse_failure: true, planning: { status: 'blocked' } },
      error: null,
      completed_at: now,
    })).toEqual(expect.arrayContaining([
      'Done lifecycle must not carry stale parse_failure result data.',
      "Done lifecycle must not carry stale result.planning.status='blocked'.",
    ]));
  });

  it('checks reviewer evidence completeness', () => {
    const goal = card({ id: 'goal-a', type: 'goal', result: { evidence_card_ids: ['child-a', 'child-b'] } });
    const result = validateEvidenceCompleteness({
      card: goal,
      readCard: (id) => id === 'child-a' ? card({ id, status: 'done', result: { ok: true } }) : card({ id, status: 'active' }),
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
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'needs_verification', error: null, completed_at: null }));
    expect(fx.transitions[0]).toEqual(expect.objectContaining({ event: 'executor_partial_finish' }));
  });

  it('commits reviewer pass and clears stale card error', async () => {
    const fx = effects();
    const receipt = await commitReviewerPass({
      card: card({ id: 'goal-a', type: 'goal', status: 'blocked', error: 'stale blocked reason' }),
      planning: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'planned' },
      reviewSummary: 'passed',
      assessmentId: 'assessment-1',
      completedAt: now,
      effects: fx,
    });

    expect(receipt.lifecycle.error).toBeNull();
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'done', error: null, completed_at: now }));
    expect(receipt.result).toEqual(expect.objectContaining({ kind: 'reviewer_pass', review_summary: 'passed' }));
  });

  it('commits reviewer pass with fallback planning context', async () => {
    const fx = effects();
    const receipt = await commitReviewerPass({
      card: card({ id: 'goal-a', type: 'goal', result: { previous: true } }),
      reviewSummary: 'passed',
      assessmentId: 'assessment-1',
      completedAt: now,
      effects: fx,
    });

    expect(receipt.result).toEqual({
      kind: 'reviewer_pass',
      planning: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'passed' },
      review_summary: 'passed',
      assessment_id: 'assessment-1',
    });
  });

  it('rejects planner done for parent goal and commits it for planning-only cards', async () => {
    const fx = effects();
    await expect(commitPlannerDone({
      card: card({ id: 'goal-a', type: 'goal' }),
      createdCards: [],
      updatedCards: [],
      summary: 'done',
      completedAt: now,
      effects: fx,
    })).rejects.toThrow("Planner done cannot be terminal for parent card type 'goal'.");

    const receipt = await commitPlannerDone({
      card: card({ id: 'doc-a', type: 'doc' }),
      createdCards: ['child-a'],
      updatedCards: [],
      summary: 'doc planning done',
      completedAt: now,
      effects: fx,
    });
    expect(receipt.lifecycle.result).toEqual({ kind: 'planner_done', created_cards: ['child-a'], updated_cards: [], summary: 'doc planning done' });
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
