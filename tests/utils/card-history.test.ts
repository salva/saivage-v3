import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore, closeTestProject, initProjectTree } from '../helpers/canonical-project.js';

describe('canonical card history', () => {
  let root: string;
  let store: CardStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'canonical-card-history-'));
    initProjectTree(root);
    store = new CardStore(root);
  });
  afterEach(() => { closeTestProject(root); rmSync(root, { recursive: true, force: true }); });

  function create() {
    return store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'Goal brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
  }

  it('starts at local version one without history', () => {
    const card = create();
    expect(card.version_seq).toBe(1);
    expect(store.listCardHistory(card.id)).toEqual([]);
  });

  it('stores each pre-mutation snapshot inside the next canonical card artifact', () => {
    const card = create();
    const updated = store.mutateCard(card.id, { title: 'Updated', priority: 2 }, { actor: 'analyst', surface: 'web-chat', reason: 'edit' });
    expect(updated.version_seq).toBe(2);
    expect(store.listCardHistory(card.id)).toEqual([expect.objectContaining({ kind: 'mutate', version_seq: 1, snapshot: card, changed_fields: expect.arrayContaining(['title', 'priority']) })]);
    expect(store.recordReader.cardArtifacts(card.id).current.history).toMatchObject({ version_seq: 1, snapshot: card });
  });

  it('preserves historical reads and diffs after canonical reopen', () => {
    const card = create();
    store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    const version3 = store.mutateCard(card.id, { tags: ['x'], priority: 4 }, { actor: 'planner', surface: 'runtime' });
    closeTestProject(root);
    store = new CardStore(root);
    expect(store.getCardAt(card.id, 1).title).toBe('Goal');
    expect(store.getCardAt(card.id, 2).title).toBe('Goal 2');
    expect(store.getCardAt(card.id, 3)).toEqual(version3);
    expect(store.diffCard(card.id, 1, 3).map(({ field }) => field)).toEqual(expect.arrayContaining(['title', 'tags', 'priority', 'version_seq']));
  });

  it('records status transitions as canonical history', () => {
    const card = create();
    store.setStatus(card.id, 'running');
    expect(store.listCardHistory(card.id)).toEqual([expect.objectContaining({ kind: 'status', version_seq: 1, changed_fields: expect.arrayContaining(['status']) })]);
  });
});
