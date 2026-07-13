import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore, initProjectTree } from '../helpers/canonical-project.js';

describe('injected canonical CardStore façade', () => {
  let root: string;
  let store: CardStore;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-card-store-')); initProjectTree(root); store = new CardStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function create(title = 'Goal') {
    return store.create({ type: 'goal', parent: 'project', title, brief: '# Goal\n\nTest.\n\n# Instructions\n\nDo it.\n\n# Acceptance Criteria\n\n- Done.\n', status: 'backlog', depth: 1, tags: [], priority: 1, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  }

  it('creates canonical card and required brief artifacts through the shared authority', () => {
    const card = create();
    expect(store.read(card.id)).toMatchObject({ version_seq: 1, title: 'Goal' });
    expect(store.readRecord(card.id, 'brief.md').artifact).toMatchObject({ state: 'closed', version: 1 });
  });

  it('persists card history in the same canonical card artifact', () => {
    const card = create();
    store.mutateCard(card.id, { title: 'Updated' }, { actor: 'analyst', surface: 'web-chat', reason: 'test' });
    expect(store.listCardHistory(card.id)).toHaveLength(1);
    expect(store.getCardAt(card.id, 2).title).toBe('Updated');
  });

  it('allocates sequential ids against the latest authority generation across façades', () => {
    expect(create().id).toBe('card-1');
    const second = new CardStore(root);
    expect(second.create({ type: 'goal', parent: 'project', title: 'Second', brief: 'Second', status: 'backlog', depth: 1, tags: [], priority: 1, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 }).id).toBe('card-2');
  });

  it('keeps ordinary reads in memory until explicit invalidation', () => {
    const second = new CardStore(root);
    const card = create();
    expect(second.read(card.id)).toBeNull();
    second.invalidate();
    expect(second.read(card.id)?.id).toBe(card.id);
  });

  it('serializes multi-card reorder without validating a transient prefix', () => {
    const first = create('First'); const second = create('Second');
    expect(store.reorderChildren('project', [second.id, first.id], { actor: 'runtime', surface: 'runtime', reason: 'test' })).toEqual({ ok: true, changed: 2 });
    expect(store.listChildren('project')).toEqual([second.id, first.id]);
  });
});
