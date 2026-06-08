import { describe, expect, it } from '@jest/globals';
import { handleReviewerAssessmentDecision, type ReviewerAssessmentEffects } from '../../src/runtime/phases/reviewer-assessment-handler.js';
import type { CardRecord, ReviewAssessment } from '../../src/schemas/types.js';
import type { ReviewerResult } from '../../src/contracts/index.js';
import type { SyntheticPlannerNote } from '../../src/runtime/synthetic-planner-notes.js';

const now = '2026-01-01T00:00:00.000Z';
const directOwnership = { kind: 'direct', source: 'project_root' } as const;
const activationOwnership = { kind: 'activation', activation_id: 'act-goal-a', parent_run_id: 'run-parent', parent_card_id: 'project', parent_session_id: 'planner:project', parent_tool_call_id: 'call-goal-a' } as const;

function reviewResult(result: ReviewerResult['assessment']['result']): ReviewerResult {
  return {
    assessment: {
      result,
      summary: 'review summary',
      achieved: [],
      issues: [],
      evidence_card_ids: ['goal-a'],
    },
  } as ReviewerResult;
}

function note(kind: SyntheticPlannerNote['kind']): SyntheticPlannerNote {
  return {
    id: `note-${kind}`,
    target_planner_session_id: 'planner:goal-a',
    target_goal_card_id: 'goal-a',
    kind,
    affected_card_id: 'goal-a',
    descendant_card_ids: [],
    summary: kind,
    created_at: now,
  };
}

describe('reviewer assessment handler', () => {
  it('turns invalid pass into needs-corrections and continues planner loop', async () => {
    const failed: ReviewAssessment[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: directOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'invalid_pass', reason: 'missing evidence' },
      effects: testEffects({ emitReviewFailed: (_goalId, assessment) => { failed.push(assessment); } }),
    });

    expect(outcome).toEqual({ kind: 'continue_planner' });
    expect(failed).toEqual([expect.objectContaining({ result: 'needs_corrections', summary: 'Reviewer pass rejected: missing evidence' })]);
  });

  it('persists project pass completion through the system-caller path', async () => {
    const calls: string[] = [];
    const patches: Partial<CardRecord>[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: directOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: 'stale error' } } as unknown as CardRecord),
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${'assessment' in details}`); },
        updateCard: async (_cardId, patch) => { patches.push(patch); calls.push(`update:${patch.lifecycle?.completed_at}`); },
        appendChildUnwindToolResult: (cardId, outcomeKind) => { calls.push(`unwind:${cardId}:${outcomeKind}`); return true; },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
        emitGoalCompleted: (cardId) => { calls.push(`completed:${cardId}`); },
        emitProjectRunCompleted: (cardId) => { calls.push(`project:${cardId}`); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual([
      'complete:goal-a:true',
      `update:${now}`,
      'reviewer_finished:review_pass',
      'completed:goal-a',
      'project:goal-a',
    ]);
    expect(patches[0]).toMatchObject({
      status: 'done',
      lifecycle: {
        status: 'done',
        completed_at: now,
        error: null,
        result: {
          kind: 'reviewer_pass',
          planning: { kind: 'planner_done', summary: 'review summary' },
          review_summary: 'review summary',
          assessment_id: 'assessment-goal-a-1',
        },
      },
    });
  });

  it('persists child goal pass completion by unwinding to the parent planner', async () => {
    const calls: string[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: 'stale error' } } as unknown as CardRecord),
        transitionCard: async (cardId, event, details) => { calls.push(`${event}:${cardId}:${'assessment' in details}`); },
        updateCard: async (_cardId, patch) => { calls.push(`update:${patch.lifecycle?.completed_at}`); },
        appendChildUnwindToolResult: (cardId, outcomeKind) => { calls.push(`unwind:${cardId}:${outcomeKind}`); return true; },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
        emitGoalCompleted: (cardId) => { calls.push(`completed:${cardId}`); },
        emitProjectRunCompleted: (cardId) => { calls.push(`project:${cardId}`); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual([
      'complete:goal-a:true',
      `update:${now}`,
      'unwind:goal-a:done',
      'completed:goal-a',
    ]);
  });

  it('continues planner without committing or draining when a pending analyst note exists', async () => {
    const calls: string[] = [];
    const notes = [note('analyst_note')];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: 'stale error' } } as unknown as CardRecord),
        peekPlannerNotes: (plannerSessionId) => {
          calls.push(`peek:${plannerSessionId}`);
          return notes;
        },
        transitionCard: async () => { calls.push('complete'); },
        updateCard: async () => { calls.push('update'); },
        appendChildUnwindToolResult: () => { calls.push('unwind'); return true; },
        transitionRuntime: async () => { calls.push('runtime'); },
        emitGoalCompleted: () => { calls.push('completed'); },
      }),
    });

    expect(outcome).toEqual({ kind: 'continue_planner' });
    expect(calls).toEqual(['peek:planner:goal-a']);
    expect(notes).toEqual([expect.objectContaining({ kind: 'analyst_note' })]);
  });

  it('commits reviewer pass when no planner note is pending', async () => {
    const calls: string[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: null } } as unknown as CardRecord),
        peekPlannerNotes: () => [],
        transitionCard: async () => { calls.push('complete'); },
        updateCard: async () => { calls.push('update'); },
        appendChildUnwindToolResult: () => { calls.push('unwind'); return true; },
        emitGoalCompleted: () => { calls.push('completed'); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual(['complete', 'update', 'unwind', 'completed']);
  });

  it('commits reviewer pass when only reviewer_interrupted notes are pending', async () => {
    const calls: string[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: null } } as unknown as CardRecord),
        peekPlannerNotes: () => [note('reviewer_interrupted')],
        transitionCard: async () => { calls.push('complete'); },
        updateCard: async () => { calls.push('update'); },
        appendChildUnwindToolResult: () => { calls.push('unwind'); return true; },
        emitGoalCompleted: () => { calls.push('completed'); },
      }),
    });

    expect(outcome).toEqual({ kind: 'completed' });
    expect(calls).toEqual(['complete', 'update', 'unwind', 'completed']);
  });

  it('throws when activation-owned reviewer pass cannot unwind to parent', async () => {
    const calls: string[] = [];
    await expect(handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => ({ id: 'goal-a', status: 'running', lifecycle: { status: 'running', result: { kind: 'planner_done', summary: 'review summary' }, completed_at: null, error: null } } as unknown as CardRecord),
        appendChildUnwindToolResult: (cardId, outcomeKind) => { calls.push(`unwind:${cardId}:${outcomeKind}`); return false; },
        transitionRuntime: async (event, details) => { calls.push(`${event}:${details.reason}`); },
        emitGoalCompleted: (cardId) => { calls.push(`completed:${cardId}`); },
      }),
    })).rejects.toThrow(/could not unwind to parent activation/);

    expect(calls).toEqual([
      'unwind:goal-a:done',
    ]);
  });

  it('throws on reviewer pass when the goal card is missing', async () => {
    const calls: string[] = [];
    await expect(handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('pass'),
      decision: { kind: 'pass' },
      effects: testEffects({
        readCard: () => null,
        updateCard: async () => { calls.push('update'); },
        appendChildUnwindToolResult: () => { calls.push('unwind'); return true; },
        transitionRuntime: async () => { calls.push('runtime'); },
        emitGoalCompleted: () => { calls.push('completed'); },
      }),
    })).rejects.toThrow(/goal card cannot be read/);

    expect(calls).toEqual([]);
  });

  it('emits correction assessment without committing correction as lifecycle result', async () => {
    const failed: ReviewAssessment[] = [];
    const patches: Partial<CardRecord>[] = [];
    const outcome = await handleReviewerAssessmentDecision({
      goalId: 'goal-a',
      ownership: activationOwnership,
      assessmentId: 'assessment-goal-a-1',
      reviewerSessionId: 'reviewer:goal-a:assessment-goal-a-1',
      reviewResult: reviewResult('needs_corrections'),
      decision: { kind: 'needs_corrections' },
      effects: testEffects({
        emitReviewFailed: (_goalId, assessment) => { failed.push(assessment); },
        updateCard: async (_cardId, patch) => { patches.push(patch); },
      }),
    });

    expect(outcome).toEqual({ kind: 'continue_planner' });
    expect(failed).toEqual([expect.objectContaining({ result: 'needs_corrections', summary: 'review summary' })]);
    expect(patches).toEqual([]);
  });
});

function testEffects(overrides: Partial<ReviewerAssessmentEffects> = {}): ReviewerAssessmentEffects {
  return {
    projectRoot: '/tmp/saivage-test-project',
    now: () => now,
    readCard: () => null,
    transitionCard: async () => undefined,
    updateCard: async () => undefined,
    emitReviewFailed: () => undefined,
    emitGoalCompleted: () => undefined,
    appendChildUnwindToolResult: () => false,
    transitionRuntime: async () => undefined,
    emitProjectRunCompleted: () => undefined,
    peekPlannerNotes: () => [],
    ...overrides,
  };
}
