import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { parseDeferredActivationEnvelope } from '../../src/schemas/validators.js';
import type { CardRecord, ReviewerResult, RuntimeState } from '../../src/schemas/types.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  upsertRuntimeActivation,
} from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';

function makeCard(
  overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & {
  id?: string;
} {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardRecord['lifecycle']);
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
    lifecycle,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

function runtimeWithActive(cardId: string): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'running',
    project_id: 'project',
    pid: 1234,
    started_at: now,
    current_card_id: cardId,
    current_agent_session_id: 'executor:active',
    active_card_run: {
      card_id: cardId,
      card_type: 'code',
      runtime_status: 'running',
      phase: 'executor',
      caller_session_id: 'planner:goal',
      caller_tool_call_id: 'call-activate',
      planner_session_id: 'planner:goal',
      executor_session_id: 'executor:active',
      reviewer_session_id: null,
      correction_attempts: 0,
      started_at: now,
      last_turn_at: now,
    },
    paused: false,
    paused_at: null,
    updated_at: now,
    frozen_reason: null,
  };
}

function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) =>
      appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) =>
      upsertRuntimeActivation(projectRoot, input),
  };
}

function appendActivePlannerRun(projectRoot: string, cardId = 'goal'): void {
  appendRuntimeRun(projectRoot, {
    run_id: `run-${cardId}`,
    kind: 'root',
    card_id: cardId,
    parent_run_id: null,
    command_id: 'cmd-test',
    activation_id: null,
    phase: 'planner',
    runtime_status: 'running',
    session_id: `planner:${cardId}`,
    result: null,
  });
}

describe('PlannerControlExecutor', () => {
  let tmpDir: string;
  let store: CardStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-control-executor-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    initProjectTree(tmpDir);
    store = new CardStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects cancel_card when the target subtree contains the active runtime leaf', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal', status: 'active' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Child', parent: goal.id, depth: 2, status: 'active' }),
    );
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      runtimeStateProvider: () => runtimeWithActive(child.id),
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-cancel',
      toolName: 'cancel_card',
      argumentsJson: JSON.stringify({ cardId: goal.id }),
    });

    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_error',
      tool: 'cancel_card',
      tool_call_id: 'call-cancel',
    });
    expect(JSON.parse(result.content)).toEqual({
      success: false,
      tool_error: expect.objectContaining({
        kind: 'card_already_active',
        message: expect.stringContaining('active runtime leaf'),
      }),
    });
  });

  it('runs report_goal_done through reviewer assessment and passes session/assessment context', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal', status: 'active' }));
    const evidence = store.create(
      makeCard({
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        depth: 2,
        status: 'done',
        lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { summary: 'done' }, generated_files: [], verified_at: '2026-01-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-01-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    const review: ReviewerResult = {
      result: 'pass',
      summary: 'approved',
      achieved: ['done'],
      issues: [],
      evidence_card_ids: [evidence.id],
    };
    const calls: Array<{
      goalId: string;
      assessmentId: string;
      reviewerSessionId: string;
      report: unknown;
    }> = [];
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      assessmentIdFactory: () => 'assessment-1',
      reviewer: (goalId, assessmentId, reviewerSessionId, report) => {
        calls.push({ goalId, assessmentId, reviewerSessionId, report });
        return review;
      },
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-report',
      toolName: 'report_goal_done',
      argumentsJson: JSON.stringify({
        goalId: goal.id,
        status_text: 'complete',
        evidence_card_ids: [evidence.id],
      }),
    });

    expect(result.kind).toBe('tool_result');
    expect(calls).toEqual([
      {
        goalId: goal.id,
        assessmentId: 'assessment-1',
        reviewerSessionId: `reviewer:${goal.id}:assessment-1`,
        report: expect.objectContaining({
          status_text: 'complete',
          evidence_card_ids: [evidence.id],
        }),
      },
    ]);
    expect(JSON.parse(result.content)).toEqual(
      expect.objectContaining({
        accepted: true,
        assessment: expect.objectContaining({
          result: 'pass',
          assessment_id: 'assessment-1',
          reviewer_session_id: `reviewer:${goal.id}:assessment-1`,
        }),
      }),
    );
    expect(store.read(goal.id)?.status).toBe('done');
  });

  it('persists a precise reviewer-capacity blocker when report_goal_done reviewer invocation fails', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal', status: 'active' }));
    const evidence = store.create(
      makeCard({
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        depth: 2,
        status: 'done',
        lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { summary: 'done' }, generated_files: [], verified_at: '2026-01-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-01-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      assessmentIdFactory: () => 'assessment-unavailable',
      reviewer: () => {
        throw new Error('provider pool exhausted');
      },
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-report',
      toolName: 'report_goal_done',
      argumentsJson: JSON.stringify({
        goalId: goal.id,
        status_text: 'complete',
        evidence_card_ids: [evidence.id],
      }),
    });

    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_error',
      tool: 'report_goal_done',
      tool_call_id: 'call-report',
    });
    const body = JSON.parse(result.content);
    expect(body).toEqual({
      success: false,
      tool_error: expect.objectContaining({
        kind: 'reviewer_invocation_failed',
        message: expect.stringContaining('reviewer/provider capacity is unavailable'),
      }),
    });
    const blocked = store.read(goal.id);
    expect(blocked).toMatchObject({
      status: 'blocked',
      lifecycle: expect.objectContaining({
        error: expect.stringContaining(
          'Reviewer invocation failed before assessment output could be produced',
        ),
      }),
    });
    expect(blocked?.lifecycle.error).not.toContain('provider pool exhausted');
    expect(blocked?.lifecycle.result).toMatchObject({
      kind: 'planner_blocked',
        resume_reason: 'reviewer_unavailable',
        created_cards: [],
        updated_cards: [],
    });
  });

  it('does not write legacy correction note files after reviewer retries are exhausted', async () => {
    const goal = store.create(
      makeCard({ type: 'goal', title: 'Goal', status: 'active', retries: 1 }),
    );
    const review: ReviewerResult = {
      result: 'needs_corrections',
      summary: 'fix it',
      achieved: [],
      issues: [{ summary: 'missing evidence', severity: 'blocker' }],
      evidence_card_ids: [],
    };
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      maxReviewRetries: 1,
      assessmentIdFactory: () => 'assessment-fail',
      reviewer: () => review,
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-report',
      toolName: 'report_goal_done',
      argumentsJson: JSON.stringify({ goalId: goal.id, status_text: 'complete' }),
    });

    expect(result.kind).toBe('tool_result');
    expect(store.read(goal.id)?.status).toBe('changed');
    expect(existsSync(join(tmpDir, '.saivage', 'notes'))).toBe(false);
  });

  it('dispatches queue_notification through planner-control and audits planner runtime surface', async () => {
    store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'active' }));
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-notify',
      toolName: 'queue_notification',
      argumentsJson: JSON.stringify({
        recipient: 'goal',
        kind: 'heads_up',
        body: 'planner body must not audit',
      }),
    });

    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'queue_notification',
      tool_call_id: 'call-notify',
    });
    expect(JSON.parse(result.content)).toEqual({
      success: true,
      data: { queued: true, recipient: 'goal' },
    });
    const audit = listControlActions(tmpDir).find(
      (entry) => entry.action === 'notification.queue' && entry.target_id === 'goal',
    );
    expect(audit).toEqual(
      expect.objectContaining({ actor: 'planner', surface: 'runtime', outcome: 'ok' }),
    );
    expect(audit?.outcome_summary).toBe('heads_up');
    expect(audit?.params_summary).not.toContain('planner body must not audit');
    expect(audit?.outcome_summary).not.toContain('planner body must not audit');
  });

  it('returns successful activate_card as a shared deferred activation envelope without mutating status', async () => {
    store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'active' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Child', parent: 'goal', depth: 2 }),
    );
    appendActivePlannerRun(tmpDir);
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const result = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-activate',
      toolName: 'activate_card',
      parentCardId: 'goal',
      argumentsJson: JSON.stringify({ cardId: child.id }),
    });

    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'activate_card',
      tool_call_id: 'call-activate',
    });
    const body = JSON.parse(result.content);
    expect(body.success).toBe(true);
    expect(parseDeferredActivationEnvelope(JSON.stringify(body.deferred))).toEqual(
      expect.objectContaining({
        parent_card_id: 'goal',
        child_card_id: child.id,
        planner_session_id: 'planner:goal',
        tool_call_id: 'call-activate',
      }),
    );
    expect(store.read(child.id)?.status).toBe('backlog');
  });

  it('preserves service success and tool_error payload shapes', async () => {
    store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'active' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child' }));
    const blockedDep = store.create(makeCard({ type: 'code', title: 'Dep', status: 'blocked' }));
    const blockedTarget = store.create(
      makeCard({
        type: 'code',
        title: 'Blocked target',
        parent: 'goal',
        depth: 2,
        depends_on: [blockedDep.id],
      }),
    );
    appendActivePlannerRun(tmpDir);
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const cancel = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-cancel',
      toolName: 'cancel_card',
      argumentsJson: JSON.stringify({ cardId: child.id }),
    });
    expect(cancel.kind).toBe('tool_result');
    expect(JSON.parse(cancel.content)).toEqual(
      expect.objectContaining({
        success: true,
        card: expect.objectContaining({ id: child.id, status: 'cancelled' }),
      }),
    );

    const activate = await executor.execute({
      sessionId: 'planner:goal',
      toolCallId: 'call-activate',
      toolName: 'activate_card',
      parentCardId: 'goal',
      argumentsJson: JSON.stringify({ cardId: blockedTarget.id }),
    });
    expect(activate.kind).toBe('tool_error');
    expect(JSON.parse(activate.content)).toEqual(
      expect.objectContaining({
        success: false,
        actionable_error: expect.objectContaining({ code: 'activate_card_dependencies_blocked' }),
        dep_failures: [{ dep_id: blockedDep.id, planner_state: 'blocked' }],
      }),
    );
  });
});
