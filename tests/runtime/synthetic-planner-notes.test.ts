import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeGoalContextCoordinator } from '../../src/runtime/runtime-goal-context.js';
import {
  consumeChangedCardActivation,
  injectQueuedSyntheticPlannerNotes,
  peekSyntheticPlannerNotes,
  queueSyntheticPlannerNote,
} from '../../src/runtime/synthetic-planner-notes.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(
  overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & {
  id?: string;
} {
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
    created_by: 'analyst',
    assigned_to: null,
    depends_on: [],
    related: [],
    acceptance: '',
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
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

function readQueuedNotes(root: string): Array<{ id: string; kind: string; affected_card_id: string }> {
  const path = join(root, '.saivage', 'runtime', 'synthetic-notes.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf-8')) as { notes: [] }).notes;
}

describe('synthetic planner notes', () => {
  let tmpDir: string;
  let store: CardStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-synthetic-notes-'));
    initProjectTree(tmpDir);
    store = new CardStore(tmpDir);
    store.create(makeCard({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project' }));
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

  it('leaves queued notes untouched on the legacy direct injection path', () => {
    queueSyntheticPlannerNote(tmpDir, {
      target_planner_session_id: 'planner:goal-1',
      target_goal_card_id: 'goal-1',
      kind: 'analyst_note',
      affected_card_id: 'goal-1',
      descendant_card_ids: [],
      summary: 'x',
    });

    expect(injectQueuedSyntheticPlannerNotes(tmpDir, 'planner:goal-1', {
      stampUserMessage: () => ({
        round_id: 'r-user-00000000000000000000000000000001',
        message_index: 0,
        block_index: 0,
      }),
    })).toBe(0);

    expect(readQueuedNotes(tmpDir)).toEqual([
      expect.objectContaining({ kind: 'analyst_note', affected_card_id: 'goal-1' }),
    ]);
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
      sessionStamper: {
        recordAppend: () => undefined,
        openAssistantRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        stampInRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        stampUserMessage: () => ({ round_id: 'r-user-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        stampPre: () => ({ round_id: 'r-pre-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        stampCompacted: () => ({ round_id: 'r-compact-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        stampDiagnosticInCurrentRound: () => ({ round_id: 'r-diagnostic-00000000000000000000000000000002', message_index: 0, block_index: 0 }),
        closeRound: () => undefined,
      },
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
