import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import type { CardRecord, RuntimeState } from '../../src/schemas/types.js';
import { PlannerToolError, PlannerToolsService } from '../../src/utils/planner-tools.js';

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

  it('rejects activation of terminal cards with terminal_card_requires_restart', () => {
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
      pid: process.pid,
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

  it('cancels only allowed statuses and refuses subtrees containing an active descendant leaf', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Parent' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, status: 'active' }));
    runtimeState = {
      status: 'running',
      project_id: 'project',
      pid: process.pid,
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
    expect(tools.cancelCard(goal.id).status).toBe('cancelled');
  });

  it('blocks delete and restart while the active runtime leaf is inside the target subtree', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Parent', status: 'backlog' }));
    const child = store.create(makeCard({ id: 'code-1', type: 'code', title: 'Child', parent: goal.id, status: 'done' }));
    store.update(goal.id, { status: 'done' });
    runtimeState = {
      status: 'running',
      project_id: 'project',
      pid: process.pid,
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
    expect(() => tools.deleteCard(goal.id)).toThrow(PlannerToolError);
    expect(() => tools.restartCard(goal.id)).toThrow(PlannerToolError);
  });

  it('deletes only cancelled or terminal cards', () => {
    const active = store.create(makeCard({ type: 'code', title: 'Active Leaf', status: 'active' }));
    expect(() => tools.deleteCard(active.id)).toThrow(/cancelled or terminal/i);
    const cancelled = store.create(makeCard({ type: 'code', title: 'Cancelled Leaf', status: 'cancelled' }));
    tools.deleteCard(cancelled.id);
    expect(store.read(cancelled.id)).toBeNull();
  });

  it('restarts terminal goal and project cards and clears mirrored report fields', () => {
    const goal = store.create(makeCard({
      type: 'goal',
      title: 'Goal Restart',
      status: 'done',
      status_text: 'old',
      status_text_updated_at: new Date().toISOString(),
      status_text_author_session_id: 'planner-1',
      latest_self_report: { outcome: 'done' },
      result: { latest_self_report: { outcome: 'done' } },
    }));
    const restarted = tools.restartCard(goal.id);
    expect(restarted.status).toBe('backlog');
    expect(restarted.result).toBeNull();
    expect(restarted.status_text).toBeNull();
    expect(restarted.latest_self_report).toBeNull();

    const project = store.read('project')!;
    store.update(project.id, { status: 'failed', status_text: 'broken', latest_self_report: { outcome: 'failed' }, result: { latest_self_report: { outcome: 'failed' } } });
    const restartedProject = tools.restartCard(project.id);
    expect(restartedProject.status).toBe('backlog');
    expect(restartedProject.status_text).toBeNull();
    expect(restartedProject.latest_self_report).toBeNull();
  });

  it('requires status_text and mirrors accepted goal reports', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Done' }));
    const evidence = store.create(makeCard({ id: 'code-evidence', type: 'code', title: 'Evidence', parent: goal.id, status: 'done', result: { ok: true } }));
    const result = tools.reportGoal('report_goal_done', goal.id, {
      status_text: 'Goal completed successfully',
      summary: 'All work is complete.',
      evidence_card_ids: [evidence.id],
    }, 'planner-session');
    expect(result.accepted).toBe(true);
    expect(result.card.status).toBe('done');
    expect(result.card.status_text).toBe('Goal completed successfully');
    expect(result.card.latest_self_report).toEqual(expect.objectContaining({ summary: 'All work is complete.', evidence_card_ids: [evidence.id], status_text: 'Goal completed successfully' }));
  });

  it('rejects invalid evidence without mutating mirrored report fields', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Invalid Evidence', status_text: 'before', latest_self_report: { summary: 'before' } }));
    const outsider = store.create(makeCard({ type: 'code', title: 'Outsider', status: 'done', result: { ok: true } }));
    expect(() => tools.reportGoal('report_goal_done', goal.id, { status_text: 'new', evidence_card_ids: [outsider.id] })).toThrow(PlannerToolError);
    const persisted = store.read(goal.id)!;
    expect(persisted.status_text).toBe('before');
    expect(persisted.latest_self_report).toEqual({ summary: 'before' });
  });

  it('rejects subtree_not_ready without mutating mirrored report fields', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal Blocked', status_text: 'unchanged', latest_self_report: { summary: 'unchanged' } }));
    store.create(makeCard({ type: 'code', title: 'Blocked Child', parent: goal.id, status: 'blocked' }));
    expect(() => tools.reportGoal('report_goal_done', goal.id, { status_text: 'should not persist' })).toThrow(PlannerToolError);
    const persisted = store.read(goal.id)!;
    expect(persisted.status_text).toBe('unchanged');
    expect(persisted.latest_self_report).toEqual({ summary: 'unchanged' });
  });
});
