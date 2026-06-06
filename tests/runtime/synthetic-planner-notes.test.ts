import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import {
  consumeChangedCardActivation,
  injectQueuedSyntheticPlannerNotes,
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
    store.setStatus(goal.id, 'active');
    store.setStatus(goal.id, 'running');
    store.setStatus(goal.id, 'changed');

    expect(() => consumeChangedCardActivation(tmpDir, goal.id)).not.toThrow();

    expect(store.read(goal.id)!.status).toBe('changed');
  });

  it('does not drop queued notes when appendMessage throws', () => {
    queueSyntheticPlannerNote(tmpDir, {
      target_planner_session_id: 'planner:goal-1',
      target_goal_card_id: 'goal-1',
      kind: 'analyst_note',
      affected_card_id: 'goal-1',
      descendant_card_ids: [],
      summary: 'x',
    });
    mkdirSync(join(tmpDir, '.saivage', 'agents', 'messages'), { recursive: true });
    mkdirSync(join(tmpDir, '.saivage', 'agents', 'messages', 'planner:goal-1.jsonl'));

    expect(() =>
      injectQueuedSyntheticPlannerNotes(tmpDir, 'planner:goal-1', {
        stampUserMessage: () => ({
          round_id: 'r-user-00000000000000000000000000000001',
          message_index: 0,
          block_index: 0,
        }),
      }),
    ).toThrow();

    expect(readQueuedNotes(tmpDir)).toEqual([
      expect.objectContaining({ kind: 'analyst_note', affected_card_id: 'goal-1' }),
    ]);
  });
});
