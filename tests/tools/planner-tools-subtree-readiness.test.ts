import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { PlannerToolError, PlannerToolsService } from '../../src/tools/planner-tools.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';
import type { NewCardInput } from '../../src/cards/lifecycle.js';

function makeCard(overrides: Partial<NewCardInput> & { id: string; type: NewCardInput['type']; parent: string | null; depth: number; title: string }): NewCardInput & { id: string } {
  return {
    brief: overrides.title,
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    assigned_to: null,
    depends_on: [],
    related: [],
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
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

function setStatus(store: CardStore, id: string, status: CardStatus): void {
  if (status === 'backlog') return;
  if (status === 'done') {
    store.repairTerminalLifecycle(id, {
      status,
      lifecycle: {
        status,
        result: { kind: 'executor_success', executor: { summary: 'done' }, verified_at: '2026-01-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-01-01T00:00:00.000Z' }, warnings: [] },
        error: null,
        completed_at: '2026-01-01T00:00:00.000Z',
      },
    });
    return;
  }
  if (status === 'failed') {
    store.repairTerminalLifecycle(id, {
      status,
      lifecycle: {
        status,
        result: { kind: 'executor_failure', error: 'failed', partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: 'failed', status_text: 'failed', at: '2026-01-01T00:00:00.000Z' } },
        error: 'failed',
        completed_at: '2026-01-01T00:00:00.000Z',
      },
    });
    return;
  }
  if (store.read(id)?.status === 'backlog') store.setStatus(id, 'running');
  if (status !== 'running') store.setStatus(id, status);
}

describe('PlannerToolsService report_goal_done subtree gate', () => {
  let projectRoot: string;
  let store: CardStore;
  let goalId: string;
  let childId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planner-tools-readiness-'));
    initProjectTree(projectRoot);
    store = new CardStore(projectRoot);
    const project = store.create(makeCard({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project' }));
    goalId = store.create(makeCard({ id: 'goal', type: 'goal', parent: project.id, depth: 1, title: 'goal' })).id;
    childId = store.create(makeCard({ id: 'child', type: 'code', parent: goalId, depth: 2, title: 'child' })).id;
    store.setStatus(goalId, 'running');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.each(['backlog', 'running', 'blocked', 'changed', 'needs_verification'] as CardStatus[])('rejects non-terminal descendant status %s', (status) => {
    setStatus(store, childId, status);
    const service = new PlannerToolsService(store);

    expect(() => service.reportGoal('report_goal_done', goalId, { status_text: 'done' })).toThrow(PlannerToolError);
    try {
      service.reportGoal('report_goal_done', goalId, { status_text: 'done' });
    } catch (err) {
      expect(err).toBeInstanceOf(PlannerToolError);
      expect((err as PlannerToolError).kind).toBe('subtree_not_ready');
      expect((err as PlannerToolError).message).toContain('non-terminal');
      expect((err as PlannerToolError).payload).toEqual({ reasons: [{ kind: 'descendant_not_terminal', card_id: childId, status }] });
    }
  });

  it.each(['done', 'failed', 'cancelled'] as CardStatus[])('accepts terminal descendant status %s', (status) => {
    setStatus(store, childId, status);
    const service = new PlannerToolsService(store);

    const result = service.reportGoal('report_goal_done', goalId, { status_text: 'done' });

    expect(result.card.status).toBe('running');
    expect(result.card.lifecycle).toEqual({
      status: 'running',
      result: { kind: 'planner_done', summary: 'done' },
      error: null,
      completed_at: null,
    });
  });
});
