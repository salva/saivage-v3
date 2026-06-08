import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createSession } from '../../src/runtime/session-persistence.js';
import { propagateChange } from '../../src/runtime/changed-propagation.js';
import { peekSyntheticPlannerNotes } from '../../src/runtime/synthetic-planner-notes.js';
import type { CardRecord, CardStatus } from '../../src/schemas/index.js';

function makeCard(overrides: Partial<CardRecord> & { id: string; type: CardRecord['type']; parent: string | null; depth: number; title: string }): Omit<CardRecord, 'created_at' | 'updated_at' | 'version_seq' | 'position'> & { id: string } {
  return {
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

function setStatus(store: CardStore, id: string, status: CardStatus): void {
  const card = store.read(id)!;
  if (status === 'backlog') return;
  if (status === 'done') {
    store.repairTerminalLifecycle(id, {
      status,
      lifecycle: {
        status,
        result: { kind: 'planner_done', summary: 'done' },
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
        result: { kind: 'planner_failure', error: 'failed' },
        error: 'failed',
        completed_at: '2026-01-01T00:00:00.000Z',
      },
    });
    return;
  }
  if (card.status === 'backlog') store.setStatus(id, 'running');
  if (status !== 'running') store.setStatus(id, status);
}

describe('changed propagation', () => {
  let projectRoot: string;
  let store: CardStore;
  let projectId: string;
  let goalAId: string;
  let goalBId: string;
  let cardCId: string;
  let siblingId: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-changed-propagation-'));
    initProjectTree(projectRoot);
    store = new CardStore(projectRoot);
    projectId = store.create(makeCard({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project' })).id;
    goalAId = store.create(makeCard({ id: 'goal-a', type: 'goal', parent: projectId, depth: 1, title: 'A' })).id;
    goalBId = store.create(makeCard({ id: 'goal-b', type: 'goal', parent: goalAId, depth: 2, title: 'B' })).id;
    cardCId = store.create(makeCard({ id: 'card-c', type: 'code', parent: goalBId, depth: 3, title: 'C' })).id;
    siblingId = store.create(makeCard({ id: 'sibling', type: 'code', parent: goalBId, depth: 3, title: 'Sibling' })).id;
    createSession(join(projectRoot, '.saivage'), 'planner', projectId, projectId, undefined, `planner:${projectId}`);
    createSession(join(projectRoot, '.saivage'), 'planner', goalAId, goalAId, undefined, `planner:${goalAId}`);
    createSession(join(projectRoot, '.saivage'), 'planner', goalBId, goalBId, undefined, `planner:${goalBId}`);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('walks nearest-first, stops flipping at running, fans out to the full planner chain, and records previous_status', () => {
    setStatus(store, projectId, 'done');
    setStatus(store, goalAId, 'running');
    setStatus(store, goalBId, 'done');
    setStatus(store, cardCId, 'done');
    setStatus(store, siblingId, 'done');

    const result = propagateChange(projectRoot, store, cardCId, { kind: 'analyst_edit', summary: 'analyst edit' });

    expect(result.flipped).toEqual([
      { card_id: cardCId, previous_status: 'done' },
      { card_id: goalBId, previous_status: 'done' },
    ]);
    expect(result.stopped_at_running).toBe(goalAId);
    expect(store.read(cardCId)?.status).toBe('changed');
    expect(store.read(goalBId)?.status).toBe('changed');
    expect(store.read(goalAId)?.status).toBe('running');
    expect(store.read(projectId)?.status).toBe('done');
    expect(store.read(siblingId)?.status).toBe('done');
    expect(result.notified_planner_session_ids).toEqual([`planner:${goalBId}`, `planner:${goalAId}`, `planner:${projectId}`]);
    expect(peekSyntheticPlannerNotes(projectRoot, `planner:${goalBId}`)).toEqual([
      expect.objectContaining({ kind: 'subtree_changed', affected_card_id: cardCId, previous_status: 'done' }),
    ]);
    expect(peekSyntheticPlannerNotes(projectRoot, `planner:${goalAId}`)).toEqual([
      expect.objectContaining({ kind: 'subtree_changed', affected_card_id: cardCId, previous_status: 'running' }),
    ]);
    expect(peekSyntheticPlannerNotes(projectRoot, `planner:${projectId}`)).toEqual([
      expect.objectContaining({ kind: 'subtree_changed', affected_card_id: cardCId, previous_status: 'done' }),
    ]);
  });

  it('queues an analyst_note and pending_subtree_correction for own-goal analyst corrections', () => {
    setStatus(store, goalBId, 'done');

    const result = propagateChange(projectRoot, store, goalBId, { kind: 'analyst_correction', issues: [{ summary: 'needs fix' }], note: 'operator note' });

    expect(result.flipped).toEqual([{ card_id: goalBId, previous_status: 'done' }]);
    expect(peekSyntheticPlannerNotes(projectRoot, `planner:${goalBId}`)).toEqual([
      expect.objectContaining({ kind: 'analyst_note', affected_card_id: goalBId, previous_status: 'done' }),
      expect.objectContaining({ kind: 'pending_subtree_correction', affected_card_id: goalBId, previous_status: 'done' }),
    ]);
  });
});
