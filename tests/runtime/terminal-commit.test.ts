import { describe, expect, it } from '@jest/globals';
import type { CardLifecycleState, CardRecord } from '../../src/schemas/index.js';
import {
  commitExecutorParkedVerification,
  commitExecutorSuccess,
  commitPlannerBlocked,
  commitReviewerInvocationFailure,
  commitReviewerPass,
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

// Mirrors the real transition-policy behavior:
// a 'block' transition is only legal from a 'running' source, and any
// other source throws (the same RuntimeDispatchInvariantError class of failure that
// surfaced in the GetRich v2 duplicate-block incident).
function strictBlockingEffects(fromStatus: CardRecord['status']) {
  const transitions: Array<{ cardId: string; event: string; details: Record<string, unknown> }> = [];
  const patches: Array<{ cardId: string; patch: Partial<CardRecord> }> = [];
  return {
    transitions,
    patches,
    transitionCard: async (cardId: string, event: string, details: Record<string, unknown>) => {
      if (event === 'block' && fromStatus !== 'running') {
        throw new Error(`card '${cardId}' cannot transition via 'block' from '${fromStatus}'.`);
      }
      transitions.push({ cardId, event, details });
      return true;
    },
    updateCard: async (cardId: string, patch: Partial<CardRecord>) => {
      patches.push({ cardId, patch });
    },
  };
}

describe('terminal commit validators', () => {
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

  it('propagates a thrown transition and does not write', async () => {
    const fx = effects();
    fx.transitionCard = async () => { throw new Error('transition rejected by state machine'); };

    await expect(commitExecutorSuccess({
      card: card(),
      goalId: 'goal-a',
      executor: {},
      acceptedAt: now,
      completedAt: now,
      summary: 'done',
      statusText: 'done',
      sessionId: 'executor-card-a',
      effects: fx,
    })).rejects.toThrow('transition rejected by state machine');
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

  // Regression: GetRich v2 duplicate-child-block incident. A child goal already in
  // 'blocked' must not attempt a second 'block' transition (which the state machine
  // rejects and throws on, misattributing the failure to the parent planner).
  it('commitPlannerBlocked is a no-op transition when the card is already blocked', async () => {
    const fx = strictBlockingEffects('blocked');
    const blockedCard = card({
      id: 'card-25',
      type: 'goal',
      status: 'blocked',
      lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'first block', resume_reason: 'reviewer_unavailable' }, error: 'first block', completed_at: null },
    });

    const receipt = await commitPlannerBlocked({
      card: blockedCard,
      blockedReason: 'second block attempt',
      resumeReason: 'reviewer_unavailable',
      effects: fx,
    });

    expect(fx.transitions).toEqual([]);
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'blocked' }));
    expect(fx.patches).toHaveLength(1);
  });

  it('commitReviewerInvocationFailure is a no-op transition when the card is already blocked', async () => {
    const fx = strictBlockingEffects('blocked');
    const blockedCard = card({
      id: 'card-25',
      type: 'goal',
      status: 'blocked',
      lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'first block', resume_reason: 'planner_blocked' }, error: 'first block', completed_at: null },
    });

    const receipt = await commitReviewerInvocationFailure({
      card: blockedCard,
      blockedReason: 'reviewer unavailable',
      effects: fx,
    });

    expect(fx.transitions).toEqual([]);
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'blocked' }));
    expect(receipt.result).toEqual(expect.objectContaining({ kind: 'planner_blocked', blocker_cause: 'reviewer_unavailable' }));
    expect(fx.patches).toHaveLength(1);
  });

  it('still blocks normally from a running source', async () => {
    const fx = strictBlockingEffects('running');
    const receipt = await commitPlannerBlocked({
      card: card({ id: 'goal-a', type: 'goal', status: 'running' }),
      blockedReason: 'genuine block',
      resumeReason: 'reviewer_unavailable',
      effects: fx,
    });

    expect(fx.transitions).toEqual([expect.objectContaining({ event: 'block', cardId: 'goal-a' })]);
    expect(receipt.patch).toEqual(expect.objectContaining({ status: 'blocked' }));
  });

  it('preserves fail-fast: a genuinely invalid source still throws on block', async () => {
    // 'done' is not 'blocked', so the guard does not skip; the strict mock throws,
    // matching the real state machine rejecting 'done' -> 'block'.
    const fx = strictBlockingEffects('done');
    await expect(commitPlannerBlocked({
      card: card({ id: 'goal-a', type: 'goal', status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: now } }),
      blockedReason: 'should not block a done card',
      resumeReason: 'reviewer_unavailable',
      effects: fx,
    })).rejects.toThrow("cannot transition via 'block' from 'done'.");
    expect(fx.patches).toEqual([]);
  });
});
