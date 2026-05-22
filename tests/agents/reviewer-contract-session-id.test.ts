import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReviewerResult, ResultParseError } from '../../src/agents/result-parser.js';
import { createSession, getSession } from '../../src/agents/session-persistence.js';
import { reviewerResultSchema } from '../../src/schemas/validators.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../src/runtime/control.js';
import { readRuntimeState, saveRuntimeState } from '../../src/runtime/state.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { CardStore } from '../../src/utils/card-store.js';
import type { RuntimeState } from '../../src/schemas/types.js';

const canonicalAssessment = {
  result: 'needs_corrections' as const,
  summary: 'Acceptance criterion requires one more evidence artifact.',
  achieved: ['Planner created the implementation card'],
  issues: [
    {
      summary: 'Evidence card is missing a durable artifact.',
      severity: 'blocker' as const,
      evidence_card_id: 'code-1',
      recommendation: 'Attach or record durable evidence before passing review.',
    },
  ],
  evidence_card_ids: ['code-1'],
};

function makeRunningReviewerState(reviewerSessionId: string): RuntimeState {
  const at = '2026-05-19T00:00:00.000Z';
  return {
    status: 'running',
    project_id: 'project',
    pid: process.pid,
    started_at: at,
    current_card_id: 'goal-1',
    current_agent_session_id: reviewerSessionId,
    active_card_run: {
      card_id: 'goal-1',
      card_type: 'goal',
      runtime_status: 'running',
      phase: 'reviewer',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: 'planner:goal-1',
      reviewer_session_id: reviewerSessionId,
      correction_attempts: 0,
      started_at: at,
      last_turn_at: at,
    },
    paused: false,
    paused_at: null,
    queue: [],
    running_processes: [],
    updated_at: at,
    frozen_reason: null,
  };
}

describe('reviewer canonical contract', () => {
  it('accepts the canonical reviewer schema exported from validators', () => {
    expect(reviewerResultSchema.parse(canonicalAssessment)).toEqual(canonicalAssessment);

    const parsed = parseReviewerResult(JSON.stringify({ assessment: canonicalAssessment }));

    expect(parsed).toEqual({ assessment: canonicalAssessment });
  });

  it.each([
    ['fail', { assessment: { fail: true, summary: 'legacy fail', missing: [] } }],
    ['missing', { assessment: { missing: ['artifact'], summary: 'legacy missing' } }],
  ])('rejects legacy reviewer %s shapes with a typed parse error', (_shape, payload) => {
    expect(() => parseReviewerResult(JSON.stringify(payload))).toThrow(ResultParseError);
    try {
      parseReviewerResult(JSON.stringify(payload));
      throw new Error('Expected parseReviewerResult to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResultParseError);
      expect((err as ResultParseError).message).toContain('Reviewer result validation failed');
      expect((err as ResultParseError).issues.join('\n')).toMatch(/assessment\.(result|fail|missing)|Unrecognized key/);
    }
  });
});

describe('stable reviewer session ids', () => {
  let projectRoot: string;
  const reviewerSessionId = 'reviewer:goal-1:assessment-goal-1-1';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-session-'));
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    try { releaseLock(projectRoot); } catch {}
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('round-trips a preallocated reviewer session id through session persistence and pause/resume state writes', () => {
    const saivageDir = join(projectRoot, '.saivage');
    const session = createSession(saivageDir, 'reviewer', 'goal-1', null, undefined, reviewerSessionId);
    expect(session.id).toBe(reviewerSessionId);

    saveRuntimeState(projectRoot, makeRunningReviewerState(reviewerSessionId));

    const paused = pauseRuntimeControl({ projectRoot });
    expect(paused.ok).toBe(true);
    expect(paused.state?.active_card_run?.reviewer_session_id).toBe(reviewerSessionId);
    expect(paused.state?.current_agent_session_id).toBe(reviewerSessionId);

    const resumed = resumeRuntimeControl({ projectRoot });
    expect(resumed.ok).toBe(true);
    expect(resumed.state?.active_card_run?.reviewer_session_id).toBe(reviewerSessionId);
    expect(getSession(saivageDir, reviewerSessionId)?.id).toBe(reviewerSessionId);
  });

  it('preserves the interrupted reviewer id in restart recovery evidence before clearing the active reviewer phase', async () => {
    const saivageDir = join(projectRoot, '.saivage');
    createSession(saivageDir, 'reviewer', 'goal-1', null, undefined, reviewerSessionId);
    const store = new CardStore(projectRoot);
    store.create({
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      depth: 0,
      title: 'Synthetic reviewer restart goal',
      description: 'Goal under reviewer restart recovery.',
      status: 'running',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: 'Synthetic acceptance.',
      artifacts: [],
      attachments: [],
      retries: 0,
    });
    saveRuntimeState(projectRoot, makeRunningReviewerState(reviewerSessionId));

    const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: join(projectRoot, 'fixtures') } });
    await runtime.startup();

    const repaired = readRuntimeState(projectRoot);
    expect(repaired?.active_card_run?.phase).toBe('planner');
    expect(repaired?.active_card_run?.reviewer_session_id).toBeNull();
    expect(repaired?.current_agent_session_id).toBe('planner:goal-1');

    const syntheticNotes = join(projectRoot, '.saivage', 'runtime', 'synthetic-notes.json');
    // Restart recovery source anchor: src/runtime/runtime.ts repairStartupActiveCardRun queues
    // reviewer_interrupted with interrupted_reviewer_session_id=<stable reviewer session id>.
    const notes = await import('node:fs').then((fs) => fs.readFileSync(syntheticNotes, 'utf-8'));
    expect(notes).toContain('reviewer_interrupted');
    expect(notes).toContain(`interrupted_reviewer_session_id=${reviewerSessionId}`);

    await runtime.shutdown();
  });
});
