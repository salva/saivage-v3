import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { propagateChange } from '../../src/runtime/changed-propagation.js';
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
  const card = store.read(id)!;
  if (status === 'backlog') return;
  if (status === 'done') {
    store.repairTerminalLifecycle(id, {
      status,
      lifecycle: {
        status,
        result: { kind: 'done', summary: 'done' },
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
        result: { kind: 'failed', summary: 'failed' },
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
    projectId = 'project';
    goalAId = store.create(makeCard({ id: 'goal-a', type: 'goal', parent: projectId, depth: 1, title: 'A' })).id;
    goalBId = store.create(makeCard({ id: 'goal-b', type: 'goal', parent: goalAId, depth: 2, title: 'B' })).id;
    cardCId = store.create(makeCard({ id: 'card-c', type: 'code', parent: goalBId, depth: 3, title: 'C' })).id;
    siblingId = store.create(makeCard({ id: 'sibling', type: 'code', parent: goalBId, depth: 3, title: 'Sibling' })).id;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('walks nearest-first, stops flipping at running, and notifies edited card plus running ancestor', () => {
    setStatus(store, projectId, 'done');
    setStatus(store, goalAId, 'running');
    setStatus(store, goalBId, 'done');
    setStatus(store, cardCId, 'done');
    setStatus(store, siblingId, 'done');

    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const result = propagateChange(store, cardCId, { kind: 'analyst_edit', summary: 'analyst edit' }, notifyCard);

    expect(result.flipped).toEqual([
      { card_id: cardCId, previous_status: 'done' },
      { card_id: goalBId, previous_status: 'done' },
    ]);
    expect(store.read(cardCId)?.status).toBe('changed');
    expect(store.read(goalBId)?.status).toBe('changed');
    expect(store.read(goalAId)?.status).toBe('running');
    expect(store.read(projectId)?.status).toBe('done');
    expect(store.read(siblingId)?.status).toBe('done');
    expect(notifyCard).toHaveBeenCalledTimes(2);
    expect(notifyCard).toHaveBeenCalledWith(cardCId, expect.objectContaining({ message: 'Card changed: analyst edit', reason: 'card_changed' }));
    expect(notifyCard).toHaveBeenCalledWith(goalAId, expect.objectContaining({ message: 'Card changed: analyst edit', reason: 'card_changed' }));
  });

  it('notifies own-goal analyst corrections and records status transition', () => {
    setStatus(store, goalBId, 'done');

    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const result = propagateChange(store, goalBId, { kind: 'analyst_correction', issues: [{ summary: 'needs fix' }], note: 'operator note' }, notifyCard);

    expect(result.flipped).toEqual([{ card_id: goalBId, previous_status: 'done' }]);
    expect(notifyCard).toHaveBeenCalledTimes(1);
    expect(notifyCard).toHaveBeenCalledWith(goalBId, expect.objectContaining({ message: 'Card changed: needs fix operator note', reason: 'analyst_correction' }));
  });

  it('deduplicates notifications when the edited card is the first running card', () => {
    setStatus(store, goalBId, 'running');

    const notifyCard = jest.fn(() => ({ ok: true as const }));
    const result = propagateChange(store, goalBId, { kind: 'analyst_edit', summary: 'analyst edited goal' }, notifyCard);

    expect(result.flipped).toEqual([]);
    expect(notifyCard).toHaveBeenCalledTimes(1);
    expect(notifyCard).toHaveBeenCalledWith(goalBId, expect.objectContaining({ message: 'Card changed: analyst edited goal' }));
  });

  it('does not flip cancelled cards back to changed', () => {
    setStatus(store, goalBId, 'cancelled');

    const result = propagateChange(store, goalBId, { kind: 'analyst_edit', summary: 'analyst edit' });

    expect(result.flipped).toEqual([]);
    expect(store.read(goalBId)?.status).toBe('cancelled');
  });
});
