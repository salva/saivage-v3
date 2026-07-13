import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';


import type { CardRecord } from '../../src/schemas/types.js';

type Targets = { cards: number; runtime: number; agents: number };

const context = { actor: 'analyst' as const, surface: 'web-chat' as const, reason: 'freshness matrix' };

describe('CardStore semantic freshness matrix', () => {
  let root: string;
  let store: CardStore;
  let targets: Targets;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-card-freshness-'));
    initProjectTree(root);
    const changes = new ReadModelChangeBroadcaster();
    targets = { cards: 0, runtime: 0, agents: 0 };
    changes.subscribe({
      cardStateChanged: () => { targets.cards += 1; },
      runtimeChanged: () => { targets.runtime += 1; },
      agentsChanged: () => { targets.agents += 1; },
      conversationChanged: () => undefined,
    });
    store = new CardStore(root, undefined, changes);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function create(type: CardRecord['type'] = 'goal', parent = 'project'): CardRecord {
    return store.create({
      type, parent, depth: 1, title: `${type} card`, brief: `${type} brief`, status: 'backlog',
      tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0,
    });
  }

  function resetTargets(): void {
    targets = { cards: 0, runtime: 0, agents: 0 };
  }

  it('inventories every public mutation entry point and its freshness role', () => {
    const source = CardStore.prototype;
    const mutationInventory = [
      { method: 'create', role: 'durable card mutation' },
      { method: 'update', role: 'durable card mutation' },
      { method: 'mutateCard', role: 'durable card mutation' },
      { method: 'commitTerminalLifecyclePatch', role: 'durable card mutation' },
      { method: 'repairTerminalLifecycle', role: 'durable card mutation' },
      { method: 'reorderChildren', role: 'durable card mutation' },
      { method: 'updateDependsOn', role: 'durable card mutation' },
      { method: 'setStatus', role: 'durable card mutation' },
      { method: 'delete', role: 'durable card mutation' },
      { method: 'archiveAndDeleteSubtree', role: 'durable card mutation' },
      { method: 'setNotifyCard', role: 'collaborator configuration only' },
    ];
    expect(mutationInventory.filter(({ method }) => typeof source[method as keyof CardStore] !== 'function')).toEqual([]);
    expect(mutationInventory.filter(({ role }) => role === 'durable card mutation')).toHaveLength(10);
  });

  it('publishes nothing for non-semantic public mutation helpers', () => {
    const card = create();
    resetTargets();
    store.setNotifyCard(undefined);
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });
  });

  it('covers create and every patch facade with readable exact targets', () => {
    const patchRows: Array<{ name: string; mutate: (card: CardRecord) => CardRecord }> = [
      { name: 'update content', mutate: (card) => store.update(card.id, { title: 'updated' }) },
      { name: 'mutateCard content', mutate: (card) => store.mutateCard(card.id, { title: 'mutated' }, context) },
      { name: 'terminal commit content', mutate: (card) => store.commitTerminalLifecyclePatch(card.id, { title: 'committed' }) },
      { name: 'terminal repair content', mutate: (card) => store.repairTerminalLifecycle(card.id, { title: 'repaired' }) },
    ];

    const created = create();
    expect(targets).toEqual({ cards: 1, runtime: 1, agents: 0 });
    for (const row of patchRows) {
      resetTargets();
      row.mutate(created);
      expect({ row: row.name, targets }).toEqual({ row: row.name, targets: { cards: 1, runtime: 0, agents: 0 } });
    }
  });

  it.each([
    ['update', (s: CardStore, c: CardRecord) => s.update(c.id, { title: c.title })],
    ['mutateCard', (s: CardStore, c: CardRecord) => s.mutateCard(c.id, { title: c.title }, context)],
    ['commitTerminalLifecyclePatch', (s: CardStore, c: CardRecord) => s.commitTerminalLifecyclePatch(c.id, { title: c.title })],
    ['repairTerminalLifecycle', (s: CardStore, c: CardRecord) => s.repairTerminalLifecycle(c.id, { title: c.title })],
    ['updateDependsOn', (s: CardStore, c: CardRecord) => s.updateDependsOn(c.id, [])],
  ])('%s same-value patch is a true no-op', (_name, mutate) => {
    const card = create();
    resetTargets();
    const before = store.read(card.id)!;
    const result = mutate(store, before);
    expect(result.version_seq).toBe(before.version_seq);
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });
  });

  it('targets status, type, content, and dependency changes exactly', () => {
    const statusCard = create();
    resetTargets();
    store.setStatus(statusCard.id, 'running');
    expect(targets).toEqual({ cards: 1, runtime: 1, agents: 1 });
    resetTargets();
    store.setStatus(statusCard.id, 'running');
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });

    const typeCard = create();
    resetTargets();
    store.mutateCard(typeCard.id, { type: 'code' }, context);
    expect(targets).toEqual({ cards: 1, runtime: 1, agents: 0 });

    const dependency = create();
    const dependent = create();
    resetTargets();
    store.updateDependsOn(dependent.id, [dependency.id], context);
    expect(targets).toEqual({ cards: 1, runtime: 0, agents: 0 });
  });

  it('targets changed reorder only and suppresses unchanged/mismatch reorder', () => {
    const parent = create();
    const first = create('code', parent.id);
    const second = create('code', parent.id);
    resetTargets();
    expect(store.reorderChildren(parent.id, [second.id, first.id], context)).toEqual({ ok: true, changed: 2 });
    expect(targets).toEqual({ cards: 1, runtime: 0, agents: 0 });
    resetTargets();
    expect(store.reorderChildren(parent.id, [second.id, first.id], context)).toEqual({ ok: true, changed: 0 });
    expect(store.reorderChildren(parent.id, [first.id], context)).toMatchObject({ ok: false, reason: 'reorder_set_mismatch' });
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });
  });

  it('targets single and non-empty subtree deletion while empty subtree is a no-op', () => {
    const single = create();
    resetTargets();
    store.delete(single.id);
    expect(targets).toEqual({ cards: 1, runtime: 1, agents: 1 });

    const parent = create();
    const child = create('code', parent.id);
    resetTargets();
    store.archiveAndDeleteSubtree([parent.id, child.id]);
    expect(targets).toEqual({ cards: 1, runtime: 1, agents: 1 });
    resetTargets();
    store.archiveAndDeleteSubtree([]);
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });
  });

  it.each([
    ['failed create', (s: CardStore) => s.create({
      type: 'goal', parent: 'missing', depth: 1, title: 'bad', brief: 'bad', status: 'backlog', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0,
    })],
    ['failed patch', (s: CardStore) => s.update('missing', { title: 'bad' })],
    ['failed status', (s: CardStore) => s.setStatus('missing', 'running')],
    ['failed delete', (s: CardStore) => s.delete('missing')],
  ])('%s publishes nothing', (_name, mutation) => {
    resetTargets();
    expect(() => mutation(store)).toThrow();
    expect(targets).toEqual({ cards: 0, runtime: 0, agents: 0 });
  });
});
