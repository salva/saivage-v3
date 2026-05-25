import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(overrides: Partial<CardRecord> & { type?: CardRecord['type']; title?: string; parent?: string | null } = {}) {
  return {
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'project',
    depth: 0,
    title: overrides.title ?? 'Test Card',
    description: '',
    status: 'backlog' as const,
    tags: [],
    priority: 0,
    urgency: 'normal' as const,
    created_by: 'analyst' as const,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    ...(overrides.id ? { id: overrides.id } : {}),
  };
}

const ctx = { actor: 'analyst' as const, surface: 'web-chat' as const, reason: 'test' };

let tmpDir: string;
let store: CardStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-card-reorder-move-'));
  initProjectTree(tmpDir);
  store = new CardStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ordered children and bounded move', () => {
  it('appends position on create within each parent', () => {
    const parent = store.create(makeCard({ id: 'goal-a', type: 'goal', title: 'A' }));
    const first = store.create(makeCard({ id: 'code-a', parent: parent.id }));
    const second = store.create(makeCard({ id: 'code-b', parent: parent.id }));

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(store.listChildren(parent.id)).toEqual([first.id, second.id]);
  });

  it('rejects reorder set mismatches with missing and extra ids', () => {
    const parent = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const a = store.create(makeCard({ id: 'code-a', parent: parent.id }));
    const b = store.create(makeCard({ id: 'code-b', parent: parent.id }));

    const result = store.reorderChildren(parent.id, [a.id, 'code-x'], ctx);

    expect(result).toEqual({ ok: false, reason: 'reorder_set_mismatch', missing: [b.id], extra: ['code-x'] });
    expect(store.listChildren(parent.id)).toEqual([a.id, b.id]);
  });

  it('skips no-op reorder writes and keeps version_seq stable', () => {
    const parent = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const a = store.create(makeCard({ id: 'code-a', parent: parent.id }));
    const b = store.create(makeCard({ id: 'code-b', parent: parent.id }));
    const before = store.read(b.id)!;

    const result = store.reorderChildren(parent.id, [a.id, b.id], ctx);

    expect(result).toEqual({ ok: true, changed: 0 });
    expect(store.read(b.id)!.version_seq).toBe(before.version_seq);
  });

  it('accepts sibling-descent moves and closes the old-parent position hole', () => {
    const a = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const b = store.create(makeCard({ id: 'goal-b', type: 'goal' }));
    const c = store.create(makeCard({ id: 'goal-c', type: 'goal' }));
    const child = store.create(makeCard({ id: 'code-a', parent: b.id }));

    const result = store.moveCard(a.id, b.id, ctx);

    expect(result.ok).toBe(true);
    expect(store.read(a.id)).toMatchObject({ parent: b.id, position: 1 });
    expect(store.read(c.id)).toMatchObject({ parent: 'project', position: 1 });
    expect(store.listChildren('project')).toEqual([b.id, c.id]);
    expect(store.listChildren(b.id)).toEqual([child.id, a.id]);
  });

  it('accepts grandparent-ascent moves', () => {
    const parent = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const child = store.create(makeCard({ id: 'goal-b', type: 'goal', parent: parent.id }));
    const grandchild = store.create(makeCard({ id: 'code-a', parent: child.id }));

    const result = store.moveCard(grandchild.id, parent.id, ctx);

    expect(result.ok).toBe(true);
    expect(store.read(grandchild.id)).toMatchObject({ parent: parent.id, position: 1 });
    expect(store.listChildren(parent.id)).toEqual([child.id, grandchild.id]);
  });

  it('refuses cross-tree moves with the SPEC-aligned typed reason', () => {
    const a = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const b = store.create(makeCard({ id: 'goal-b', type: 'goal' }));
    const aChild = store.create(makeCard({ id: 'code-a', parent: a.id }));
    const bChild = store.create(makeCard({ id: 'goal-b-child', type: 'goal', parent: b.id }));

    const result = store.moveCard(aChild.id, bChild.id, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('move_refused_cross_tree');
      expect(result.message).toBe('Moves are restricted to the parent-child axis: move down into a current sibling, or move up out to the current grandparent.');
    }
  });

  it('refuses root moves', () => {
    const result = store.moveCard('project', 'project', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('move_refused_root');
  });

  it('refuses self-parent and descendant-parent moves', () => {
    const parent = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const child = store.create(makeCard({ id: 'goal-b', type: 'goal', parent: parent.id }));

    const self = store.moveCard(parent.id, parent.id, ctx);
    const descendant = store.moveCard(parent.id, child.id, ctx);

    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.reason).toBe('move_refused_self');
    expect(descendant.ok).toBe(false);
    if (!descendant.ok) expect(descendant.reason).toBe('move_refused_descendant');
  });

  it('refuses parent changes through update and mutateCard', () => {
    const a = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const b = store.create(makeCard({ id: 'goal-b', type: 'goal' }));

    expect(() => store.update(a.id, { parent: b.id })).toThrow(/parent.*cannot be changed via update\/mutateCard/i);
    expect(() => store.mutateCard(a.id, { parent: b.id }, ctx)).toThrow(/parent.*cannot be changed via update\/mutateCard/i);
  });
});
