import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeGoalContextCoordinator } from '../../src/runtime/runtime-goal-context.js';
import {
  consumeChangedCardActivation,
  peekSyntheticPlannerNotes,
  queueSyntheticPlannerNote,
} from '../../src/runtime/synthetic-planner-notes.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { NewCardInput } from '../../src/cards/lifecycle.js';

function makeCard(
  overrides: Partial<NewCardInput> & { id?: string; type: NewCardInput['type']; title: string },
): NewCardInput & {
  id?: string;
} {
  return {
    parent: 'project',
    depth: 1,
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

describe('synthetic planner notes', () => {
  let tmpDir: string;
  let store: CardStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-synthetic-notes-'));
    initProjectTree(tmpDir);
    store = new CardStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('consumeChangedCardActivation does not attempt changed -> running and does not throw', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'G', parent: 'project' }));
    store.setStatus(goal.id, 'running');
    store.setStatus(goal.id, 'running');
    store.setStatus(goal.id, 'changed');

    expect(() => consumeChangedCardActivation(tmpDir, goal.id)).not.toThrow();

    expect(store.read(goal.id)!.status).toBe('changed');
  });

  it('keeps reviewer context note-free and drains planner context exactly once', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'G', parent: 'project' }));
    queueSyntheticPlannerNote(tmpDir, {
      target_planner_session_id: `planner:${goal.id}`,
      target_goal_card_id: goal.id,
      kind: 'subtree_changed',
      affected_card_id: 'card-1',
      descendant_card_ids: ['card-1'],
      summary: 'analyst changed card-1',
      previous_status: 'done',
    });
    const coordinator = createRuntimeGoalContextCoordinator({
      projectRoot: tmpDir,
      cards: store,
    });

    const reviewerContext = coordinator.buildGoalContextBlock(goal.id, 'initial');

    expect(reviewerContext).not.toContain('subtree_changed');
    expect(peekSyntheticPlannerNotes(tmpDir, `planner:${goal.id}`)).toHaveLength(1);

    const plannerContext = coordinator.buildPlannerGoalContext(goal.id, 'initial');

    expect(plannerContext.resumeReason).toBe('subtree_changed');
    expect(plannerContext.goalContext).toContain('subtree_changed');
    expect(plannerContext.goalContext).toContain('previous_status');
    expect(peekSyntheticPlannerNotes(tmpDir, `planner:${goal.id}`)).toHaveLength(0);
    expect(coordinator.buildPlannerGoalContext(goal.id, 'initial').goalContext).not.toContain('subtree_changed');
  });
});
