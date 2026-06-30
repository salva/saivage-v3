import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import type { CardRecord, RuntimeState } from '../../src/schemas/types.js';
import {
  appendRuntimeRun,
  readRuntimeState,
  upsertRuntimeActivation,
} from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import type { NewCardInput } from '../../src/cards/lifecycle.js';

function makeCard(
  overrides: Partial<NewCardInput> & { id?: string; type: NewCardInput['type']; title: string },
): NewCardInput & {
  id?: string;
} {
  const status = overrides.status ?? 'backlog';
  const lifecycle = overrides.lifecycle ?? (status === 'blocked'
    ? { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked' }, error: 'blocked', completed_at: null }
    : { status, result: null, error: null, completed_at: null } as CardRecord['lifecycle']);
  return {
    parent: 'project',
    depth: 1,
    brief: overrides.title,
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    assigned_to: null,
    depends_on: [],
    related: [],
    lifecycle,
    metrics: null,
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
    active_card_run: {
      card_id: cardId,
      card_type: 'code',
      ownership: { kind: 'direct', source: 'project_root' },
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
    updated_at: now,
    runtime_commands: [],
    runtime_runs: [],
    runtime_activations: [],
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
    ownership: { kind: 'direct', source: 'project_root' }, card_id: cardId,
    parent_run_id: null,
    command_id: 'cmd-test',
    activation_id: null,
    phase: 'planner',
    runtime_status: 'running',
    session_id: `planner:${cardId}`,
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
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Child', parent: goal.id, depth: 2, status: 'running' }),
    );
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      runtimeStateProvider: () => runtimeWithActive(child.id),
    });

    const result = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-cancel',
      toolName: 'cancel_card',
      args: { cardId: child.id },
    });

    expect(result.success).toBe(false);
    expect(result.data).toEqual({
      success: false,
      tool_error: expect.objectContaining({
        kind: 'card_already_running',
        message: expect.stringContaining('running runtime leaf'),
      }),
    });
  });

  it('accepts report_goal_done without invoking a synchronous reviewer', async () => {
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const evidence = store.create(
      makeCard({
        type: 'code',
        title: 'Evidence',
        parent: goal.id,
        depth: 2,
        status: 'done',
        lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { summary: 'done' }, verified_at: '2026-01-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-01-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
    });

    const result = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-report',
      toolName: 'report_goal_done',
      args: {
        status_text: 'complete',
        evidence_card_ids: [evidence.id],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        accepted: true,
        card: expect.objectContaining({ status: 'running' }),
      }),
    );
    expect(store.read(goal.id)?.status).toBe('running');
    expect(store.read(goal.id)?.lifecycle).toEqual({
      status: 'running',
      result: { kind: 'planner_done', summary: 'complete' },
      error: null,
      completed_at: null,
    });
  });

  it('dispatches queue_notification through planner-control and audits planner runtime surface', async () => {
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const result = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-notify',
      toolName: 'queue_notification',
      args: {
        recipient: goal.id,
        kind: 'heads_up',
        body: 'planner body must not audit',
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      success: true,
      data: { queued: true, recipient: goal.id },
    });
    const audit = listControlActions(tmpDir).find(
      (entry) => entry.action === 'notification.queue' && entry.target_id === goal.id,
    );
    expect(audit).toEqual(
      expect.objectContaining({ actor: 'planner', surface: 'runtime', outcome: 'ok' }),
    );
    expect(audit?.outcome_summary).toBe('heads_up');
    expect(audit?.params_summary).not.toContain('planner body must not audit');
    expect(audit?.outcome_summary).not.toContain('planner body must not audit');
  });

  it('returns successful activate_card as a durable activation record without mutating status', async () => {
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Child', parent: goal.id, depth: 2 }),
    );
    appendActivePlannerRun(tmpDir, goal.id);
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const result = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-activate',
      toolName: 'activate_card',
      parentCardId: goal.id,
      args: { cardId: child.id },
    });

    expect(result.success).toBe(true);
    const body = result.data as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.deferred).toBeUndefined();
    expect(body.activation).toEqual(expect.objectContaining({
      parent_card_id: goal.id,
      child_card_id: child.id,
      parent_session_id: `planner:${goal.id}`,
      parent_tool_call_id: 'call-activate',
      status: 'pending',
    }));
    expect(store.read(child.id)?.status).toBe('backlog');
  });

  it('rejects activate_card for a non-child of the active parent planner', async () => {
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const nestedGoal = store.create(makeCard({ id: 'nested-goal', type: 'goal', title: 'Nested', parent: goal.id, depth: 2 }));
    const grandchild = store.create(makeCard({ type: 'code', title: 'Grandchild', parent: nestedGoal.id, depth: 3 }));
    appendActivePlannerRun(tmpDir, goal.id);
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const result = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-grandchild',
      toolName: 'activate_card',
      parentCardId: goal.id,
      args: { cardId: grandchild.id },
    });

    expect(result.success).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({
      success: false,
      actionable_error: expect.objectContaining({
        code: 'activate_card_not_direct_child',
        currentState: expect.objectContaining({
          parentCardId: goal.id,
          childCardId: grandchild.id,
          actualParentId: nestedGoal.id,
        }),
      }),
    }));
    expect(readRuntimeState(tmpDir)?.runtime_runs?.filter((run) => run.card_id === grandchild.id)).toEqual([]);
  });

  it('preserves service success and tool_error payload shapes', async () => {
    const goal = store.create(makeCard({ id: 'goal', type: 'goal', title: 'Goal', status: 'running' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: goal.id, depth: 2 }));
    const blockedDep = store.create(makeCard({ type: 'code', title: 'Dep', status: 'blocked' }));
    const blockedTarget = store.create(
      makeCard({
        type: 'code',
        title: 'Blocked target',
        parent: goal.id,
        depth: 2,
        depends_on: [blockedDep.id],
      }),
    );
    appendActivePlannerRun(tmpDir, goal.id);
    const executor = new PlannerControlExecutor({
      cardStore: store,
      projectRoot: tmpDir,
      activationLedger: activationLedger(tmpDir),
    });

    const cancel = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-cancel',
      toolName: 'cancel_card',
      args: { cardId: child.id },
    });
    expect(cancel.success).toBe(true);
    expect(cancel.data).toEqual(
      expect.objectContaining({
        success: true,
        card: expect.objectContaining({ id: child.id, status: 'cancelled' }),
      }),
    );

    const activate = await executor.execute({
      sessionId: `planner:${goal.id}`,
      toolCallId: 'call-activate',
      toolName: 'activate_card',
      parentCardId: goal.id,
      args: { cardId: blockedTarget.id },
    });
    expect(activate.success).toBe(false);
    expect(activate.data).toEqual(
      expect.objectContaining({
        success: false,
        actionable_error: expect.objectContaining({ code: 'activate_card_dependencies_blocked' }),
        dep_failures: [{ dep_id: blockedDep.id, card_status: 'blocked' }],
      }),
    );
  });
});
