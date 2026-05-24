import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardRecord, RuntimeState } from '../../src/schemas/types.js';
import { PlannerToolError, PlannerToolsService } from '../../src/tools/planner-tools.js';
import { getNotes } from '../../src/cards/notes.js';

function makeCard(
  overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq'> & { id?: string } {
  return {
    parent: 'project',
    depth: 1,
    description: '',
    status: 'backlog',
    subtype: null,
    instructions_file: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    assigned_to: null,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    result: null,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

describe('PlannerToolsService', () => {
  let root: string;
  let store: CardStore;
  let runtimeState: RuntimeState | null;
  let tools: PlannerToolsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-planner-tools-'));
    initProjectTree(root);
    store = new CardStore(root);
    runtimeState = null;
    tools = new PlannerToolsService(store, () => runtimeState);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('activates a backlog card and rejects already-active cards with card_already_active', () => {
    const card = store.create(makeCard({ type: 'code', title: 'Leaf A' }));
    expect(tools.activateCard(card.id).status).toBe('active');
    expect(() => tools.activateCard(card.id)).toThrow(PlannerToolError);
    try {
      tools.activateCard(card.id);
    } catch (error) {
      expect((error as PlannerToolError).kind).toBe('card_already_active');
    }
  });

  it('reactivates terminal goal/project cards but rejects terminal non-goal cards with terminal_card_requires_restart', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal B', status: 'done' }));
    expect(tools.activateCard(goal.id).status).toBe('active');

    const project = store.read('project')!;
    store.update(project.id, { status: 'failed' });
    expect(tools.activateCard(project.id).status).toBe('active');

    const card = store.create(makeCard({ type: 'code', title: 'Leaf B', status: 'done' }));
    try {
      tools.activateCard(card.id);
      throw new Error('expected activation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerToolError);
      expect((error as PlannerToolError).kind).toBe('terminal_card_requires_restart');
    }
  });

  it('rejects activation when the runtime leaf already points at the card', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Goal Active Leaf' }));
    runtimeState = {
      status: 'running',
      project_id: 'project',
      started_at: new Date().toISOString(),
      current_card_id: card.id,
      current_agent_session_id: 'planner-1',
      active_card_run: {
        card_id: card.id,
        card_type: card.type,
        runtime_status: 'running',
        phase: 'planner',
        caller_session_id: null,
        caller_tool_call_id: null,
        planner_session_id: 'planner-1',
        correction_attempts: 0,
        started_at: new Date().toISOString(),
        last_turn_at: new Date().toISOString(),
      },
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: new Date().toISOString(),
      frozen_reason: null,
    };
    expect(() => tools.activateCard(card.id)).toThrow(PlannerToolError);
  });

  it('cancels only backlog/active/changed, writes synthetic cancellation report, and refuses active descendant leaf', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Parent' }));
    const child = store.create(
      makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, status: 'active' }),
    );
    runtimeState = {
      status: 'running',
      project_id: 'project',
      started_at: new Date().toISOString(),
      current_card_id: child.id,
      current_agent_session_id: 'executor-1',
      active_card_run: {
        card_id: child.id,
        card_type: child.type,
        runtime_status: 'running',
        phase: 'executor',
        caller_session_id: 'planner-1',
        caller_tool_call_id: 'call-1',
        executor_session_id: 'executor-1',
        correction_attempts: 0,
        started_at: new Date().toISOString(),
        last_turn_at: new Date().toISOString(),
      },
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: new Date().toISOString(),
      frozen_reason: null,
    };
    expect(child.status).toBe('active');
    expect(() => tools.cancelCard(goal.id)).toThrow(PlannerToolError);
    runtimeState = null;
    store.update(child.id, { status: 'backlog' });
    const cancelledGoal = tools.cancelCard(goal.id);
    expect(cancelledGoal.status).toBe('cancelled');
    expect(cancelledGoal.status_text).toBeNull();
    expect(cancelledGoal.latest_self_report).toEqual(
      expect.objectContaining({ result: 'failed', outcome: 'failed', reason: 'cancelled' }),
    );

    const mirroredLeaf = store.create(
      makeCard({
        type: 'code',
        title: 'Cancel Preserves Existing Mirror',
        status: 'backlog',
        status_text: 'ready to cancel',
        latest_self_report: {
          result: 'done',
          status_text: 'ready to cancel',
          summary: 'previous mirror',
          at: new Date().toISOString(),
        },
      }),
    );
    const cancelledLeaf = tools.cancelCard(mirroredLeaf.id);
    expect(cancelledLeaf.status).toBe('cancelled');
    expect(cancelledLeaf.status_text).toBe('ready to cancel');
    expect(cancelledLeaf.latest_self_report).toEqual(
      expect.objectContaining({ status_text: 'ready to cancel' }),
    );

    const project = store.read('project')!;
    store.update(project.id, { status: 'changed' });
    const cancelledProject = tools.cancelCard(project.id);
    expect(cancelledProject.status).toBe('cancelled');

    store.update(project.id, { status: 'active' });
    const blocked = store.create(
      makeCard({ type: 'code', title: 'Blocked Leaf', status: 'blocked' }),
    );
    expect(() => tools.cancelCard(blocked.id)).toThrow(PlannerToolError);
  });

  it('blocks delete and restart while the active runtime leaf is inside the target subtree', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Parent', status: 'backlog' }));
    const child = store.create(
      makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, status: 'done' }),
    );
    store.update(goal.id, { status: 'done' });
    runtimeState = {
      status: 'running',
      project_id: 'project',
      started_at: new Date().toISOString(),
      current_card_id: child.id,
      current_agent_session_id: 'executor-1',
      active_card_run: {
        card_id: child.id,
        card_type: child.type,
        runtime_status: 'running',
        phase: 'executor',
        caller_session_id: 'planner-1',
        caller_tool_call_id: 'call-1',
        executor_session_id: 'executor-1',
        correction_attempts: 0,
        started_at: new Date().toISOString(),
        last_turn_at: new Date().toISOString(),
      },
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: new Date().toISOString(),
      frozen_reason: null,
    };
    for (const operation of [() => tools.deleteCard(goal.id), () => tools.restartCard(goal.id)]) {
      try {
        operation();
        throw new Error('expected active subtree refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(PlannerToolError);
        expect((error as PlannerToolError).kind).toBe('card_already_active');
      }
    }
  });

  it('archives and cascades destructive delete and leaves no partial mutation on preflight failure', () => {
    const goal = store.create(
      makeCard({
        id: 'goal-delete',
        type: 'goal',
        title: 'Delete Goal',
        status: 'backlog',
        result: { review: { result: 'pass' } },
      }),
    );
    const child = store.create(
      makeCard({
        id: 'goal-delete-child',
        type: 'goal',
        title: 'Delete Child',
        parent: goal.id,
        status: 'backlog',
        attachments: [
          {
            id: 'att-1',
            card_id: 'goal-delete-child',
            path: 'artifact.txt',
            mime: 'text/plain',
            title: 'artifact',
            created_at: new Date().toISOString(),
          },
        ],
        result: { executor: { ok: true } },
      }),
    );
    const grandchild = store.create(
      makeCard({
        id: 'test-delete-grandchild',
        type: 'test',
        title: 'Delete Grandchild',
        parent: child.id,
        status: 'cancelled',
      }),
    );
    store.update(child.id, { status: 'blocked' });
    store.update(goal.id, { status: 'done' });
    tools.deleteCard(goal.id);
    for (const id of [goal.id, child.id, grandchild.id]) {
      expect(store.read(id)).toBeNull();
      const archivePath = join(root, '.saivage', 'archive', 'cards', `${id}.json`);
      expect(existsSync(archivePath)).toBe(true);
      expect(JSON.parse(readFileSync(archivePath, 'utf-8')).card.id).toBe(id);
    }

    const parent = store.create(
      makeCard({ id: 'goal-rollback', type: 'goal', title: 'Rollback Goal', status: 'backlog' }),
    );
    const active = store.create(
      makeCard({
        id: 'code-rollback-active',
        type: 'code',
        title: 'Active Child',
        parent: parent.id,
        status: 'active',
      }),
    );
    store.update(parent.id, {
      status: 'done',
      status_text: 'parent terminal status',
      latest_self_report: {
        result: 'done',
        status_text: 'parent terminal status',
        summary: 'parent done',
        at: new Date().toISOString(),
      },
    });
    expect(() => tools.deleteCard(parent.id)).toThrow(PlannerToolError);
    expect(store.read(parent.id)).toEqual(
      expect.objectContaining({
        status: 'done',
        status_text: 'parent terminal status',
        latest_self_report: expect.objectContaining({ status_text: 'parent terminal status' }),
      }),
    );
    expect(store.read(active.id)?.status).toBe('active');
    expect(existsSync(join(root, '.saivage', 'archive', 'cards', `${parent.id}.json`))).toBe(false);
  });

  it('restarts terminal/changed cards to active, clears documented result fields, and preserves status_text', () => {
    const goal = store.create(
      makeCard({
        type: 'goal',
        title: 'Goal Restart',
        status: 'done',
        status_text: 'old',
        status_text_updated_at: new Date().toISOString(),
        status_text_author_session_id: 'planner-1',
        latest_self_report: { outcome: 'done' },
        result: { latest_self_report: { outcome: 'done' }, review: { result: 'pass' }, keep: true },
      }),
    );
    const restarted = tools.restartCard(goal.id);
    expect(restarted.status).toBe('active');
    expect(restarted.result).toEqual({ latest_self_report: { outcome: 'done' }, keep: true });
    expect(restarted.status_text).toBe('old');
    expect(restarted.latest_self_report).toBeNull();

    const project = store.read('project')!;
    store.update(project.id, {
      status: 'failed',
      status_text: 'broken',
      latest_self_report: { outcome: 'failed' },
      result: {
        latest_self_report: { outcome: 'failed' },
        review: { result: 'needs_corrections' },
      },
    });
    const restartedProject = tools.restartCard(project.id);
    expect(restartedProject.status).toBe('active');
    expect(restartedProject.status_text).toBe('broken');
    expect(restartedProject.latest_self_report).toBeNull();

    const leaf = store.create(
      makeCard({
        type: 'code',
        title: 'Leaf Restart',
        status: 'changed',
        status_text: 'leaf old',
        result: { executor: { ok: false }, keep: true },
      }),
    );
    const restartedLeaf = tools.restartCard(leaf.id);
    expect(restartedLeaf.status).toBe('active');
    expect(restartedLeaf.status_text).toBe('leaf old');
    expect(restartedLeaf.result).toEqual({ keep: true });
  });

  it('requires status_text and mirrors accepted goal reports', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Done' }));
    const evidence = store.create(
      makeCard({
        id: 'code-evidence',
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        status: 'done',
        result: { ok: true },
      }),
    );
    const result = tools.reportGoal(
      'report_goal_done',
      goal.id,
      {
        status_text: 'Goal completed successfully',
        summary: 'All work is complete.',
        evidence_card_ids: [evidence.id],
      },
      'planner-session',
    );
    expect(result.accepted).toBe(true);
    expect(result.card.status).toBe('done');
    expect(result.card.status_text).toBe('Goal completed successfully');
    expect(result.card.latest_self_report).toEqual(
      expect.objectContaining({
        summary: 'All work is complete.',
        evidence_card_ids: [evidence.id],
        status_text: 'Goal completed successfully',
      }),
    );
  });

  it('rejects invalid evidence without mutating mirrored report fields', () => {
    const goal = store.create(
      makeCard({
        type: 'goal',
        title: 'Goal Invalid Evidence',
        status_text: 'before',
        latest_self_report: { summary: 'before' },
      }),
    );
    const outsider = store.create(
      makeCard({ type: 'code', title: 'Outsider', status: 'done', result: { ok: true } }),
    );
    expect(() =>
      tools.reportGoal('report_goal_done', goal.id, {
        status_text: 'new',
        evidence_card_ids: [outsider.id],
      }),
    ).toThrow(PlannerToolError);
    const persisted = store.read(goal.id)!;
    expect(persisted.status_text).toBe('before');
    expect(persisted.latest_self_report).toEqual({ summary: 'before' });
  });

  it('rejects subtree_not_ready without mutating mirrored report fields', () => {
    const goal = store.create(
      makeCard({
        type: 'goal',
        title: 'Goal Blocked',
        status_text: 'unchanged',
        latest_self_report: { summary: 'unchanged' },
      }),
    );
    store.create(
      makeCard({ type: 'code', title: 'Blocked Child', parent: goal.id, status: 'blocked' }),
    );
    expect(() =>
      tools.reportGoal('report_goal_done', goal.id, { status_text: 'should not persist' }),
    ).toThrow(PlannerToolError);
    const persisted = store.read(goal.id)!;
    expect(persisted.status_text).toBe('unchanged');
    expect(persisted.latest_self_report).toEqual({ summary: 'unchanged' });
  });
});

describe('PlannerToolsService reviewer gates', () => {
  let root: string;
  let store: CardStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-planner-reviewer-gates-'));
    initProjectTree(root);
    store = new CardStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function goalWithEvidence() {
    const goal = store.create(
      makeCard({
        type: 'goal',
        title: 'Reviewed Goal',
        status_text: 'old',
        latest_self_report: { summary: 'old' },
      }),
    );
    const evidence = store.create(
      makeCard({
        id: 'code-reviewed-evidence',
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        status: 'done',
        result: { executor: { ok: true } },
      }),
    );
    return { goal, evidence };
  }

  it('orders report_goal_done gates: subtree_not_ready before invalid_evidence before reviewer', () => {
    const { goal } = goalWithEvidence();
    store.create(
      makeCard({
        id: 'blocked-child',
        type: 'code',
        title: 'Blocked',
        parent: goal.id,
        status: 'blocked',
      }),
    );
    let reviewerCalls = 0;
    const tools = new PlannerToolsService(store, {
      projectRoot: root,
      reviewer: () => {
        reviewerCalls += 1;
        return { result: 'pass', summary: 'ok', achieved: [], issues: [], evidence_card_ids: [] };
      },
    });

    try {
      tools.reportGoal('report_goal_done', goal.id, {
        status_text: 'new',
        evidence_card_ids: ['missing-evidence'],
      });
      throw new Error('expected subtree rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerToolError);
      expect((error as PlannerToolError).kind).toBe('subtree_not_ready');
      expect((error as PlannerToolError).payload).toEqual({
        reasons: [{ kind: 'descendant_blocking', card_id: 'blocked-child', status: 'blocked' }],
      });
    }
    expect(reviewerCalls).toBe(0);

    store.update('blocked-child', { status: 'done', result: { executor: { ok: true } } });
    expect(() =>
      tools.reportGoal('report_goal_done', goal.id, {
        status_text: 'new',
        evidence_card_ids: ['missing-evidence'],
      }),
    ).toThrow(PlannerToolError);
    try {
      tools.reportGoal('report_goal_done', goal.id, {
        status_text: 'new',
        evidence_card_ids: ['missing-evidence'],
      });
    } catch (error) {
      expect((error as PlannerToolError).kind).toBe('invalid_evidence');
    }
    expect(reviewerCalls).toBe(0);

    tools.reportGoal('report_goal_done', goal.id, { status_text: 'accepted' });
    expect(reviewerCalls).toBe(1);
  });

  it('does not add pending_subprocess gate behavior for running ProcessRecords', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal With Process' }));
    const running = store.create(
      makeCard({
        id: 'code-running-process',
        type: 'code',
        title: 'Running process evidence',
        parent: goal.id,
        status: 'done',
        result: { ok: true },
      }),
    );
    const tools = new PlannerToolsService(store, {
      reviewer: () => ({
        result: 'pass',
        summary: 'ok',
        achieved: [],
        issues: [],
        evidence_card_ids: [running.id],
      }),
    });
    const result = tools.reportGoal('report_goal_done', goal.id, {
      status_text: 'done despite durable process record',
      evidence_card_ids: [running.id],
    });
    expect(result.accepted).toBe(true);
  });

  it('suppresses status_text/latest_self_report mirroring for rejected evidence and reviewer needs_corrections', () => {
    const { goal } = goalWithEvidence();
    const tools = new PlannerToolsService(store, {
      reviewer: () => ({
        result: 'needs_corrections',
        summary: 'fix it',
        achieved: [],
        issues: [{ summary: 'missing proof', severity: 'blocker' }],
        evidence_card_ids: [],
      }),
    });
    expect(() =>
      tools.reportGoal('report_goal_done', goal.id, {
        status_text: 'bad evidence',
        evidence_card_ids: ['outside'],
      }),
    ).toThrow(PlannerToolError);
    tools.reportGoal('report_goal_done', goal.id, { status_text: 'not accepted' });
    const persisted = store.read(goal.id)!;
    expect(persisted.status_text).toBe('old');
    expect(persisted.latest_self_report).toEqual({ summary: 'old' });
    expect(persisted.retries).toBe(1);
    expect((persisted.result?.review as { result?: string }).result).toBe('needs_corrections');
  });

  it('mirrors status_text/latest_self_report only after reviewer pass and records preallocated assessment/session id', () => {
    const { goal, evidence } = goalWithEvidence();
    let observed: { assessmentId: string; reviewerSessionId: string } | null = null;
    const tools = new PlannerToolsService(store, {
      assessmentIdFactory: () => 'assessment-123',
      reviewer: (_goalId, assessmentId, reviewerSessionId) => {
        observed = { assessmentId, reviewerSessionId };
        return {
          result: 'pass',
          summary: 'accepted',
          achieved: ['done'],
          issues: [],
          evidence_card_ids: [evidence.id],
        };
      },
    });
    const result = tools.reportGoal(
      'report_goal_done',
      goal.id,
      { status_text: 'complete', summary: 'done', evidence_card_ids: [evidence.id] },
      'planner-session',
    );
    expect(observed).toEqual({
      assessmentId: 'assessment-123',
      reviewerSessionId: `reviewer:${goal.id}:assessment-123`,
    });
    expect(result.assessment).toEqual(
      expect.objectContaining({
        assessment_id: 'assessment-123',
        reviewer_session_id: `reviewer:${goal.id}:assessment-123`,
        result: 'pass',
      }),
    );
    expect(result.card.status).toBe('done');
    expect(result.card.status_text).toBe('complete');
    expect(result.card.latest_self_report).toEqual(
      expect.objectContaining({ summary: 'done', status_text: 'complete', result: 'done' }),
    );
    expect(result.card.retries).toBe(0);
  });

  it('exhausts reviewer retries by leaving issues on result.review, flipping origin changed, and writing pending_subtree_correction notes on origin and strict ancestors', () => {
    const parent = store.create(
      makeCard({ id: 'goal-parent-review', type: 'goal', title: 'Parent' }),
    );
    const goal = store.create(
      makeCard({ id: 'goal-child-review', type: 'goal', title: 'Child', parent: parent.id }),
    );
    store.create(
      makeCard({
        id: 'code-child-review-evidence',
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        status: 'done',
        result: { executor: { ok: true } },
      }),
    );
    const issue = {
      summary: 'acceptance missing',
      severity: 'blocker' as const,
      recommendation: 'add tests',
    };
    const tools = new PlannerToolsService(store, {
      projectRoot: root,
      maxReviewRetries: 0,
      assessmentIdFactory: () => 'assessment-exhausted',
      reviewer: () => ({
        result: 'needs_corrections',
        summary: 'no',
        achieved: [],
        issues: [issue],
        evidence_card_ids: [],
      }),
    });
    const result = tools.reportGoal('report_goal_done', goal.id, { status_text: 'claim complete' });
    expect(result.card.status).toBe('changed');
    const persisted = store.read(goal.id)!;
    expect(persisted.status).toBe('changed');
    expect((persisted.result?.review as { issues?: unknown[] }).issues).toEqual([issue]);
    expect(
      getNotes(join(root, '.saivage'), goal.id).some(
        (note) =>
          note.content.includes('pending_subtree_correction') &&
          note.content.includes('acceptance missing'),
      ),
    ).toBe(true);
    expect(
      getNotes(join(root, '.saivage'), parent.id).some(
        (note) =>
          note.content.includes('pending_subtree_correction') &&
          note.content.includes('acceptance missing'),
      ),
    ).toBe(true);
    expect(
      getNotes(join(root, '.saivage'), 'project').some(
        (note) =>
          note.content.includes('pending_subtree_correction') &&
          note.content.includes('acceptance missing'),
      ),
    ).toBe(true);
  });
});
