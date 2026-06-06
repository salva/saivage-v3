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
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-card-reorder-'));
  initProjectTree(tmpDir);
  store = new CardStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ordered children', () => {
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

  it('reorders top-level cards under the virtual project root', () => {
    const a = store.create(makeCard({ id: 'goal-a', type: 'goal', title: 'A' }));
    const b = store.create(makeCard({ id: 'goal-b', type: 'goal', title: 'B' }));

    const result = store.reorderChildren('project', [b.id, a.id], ctx);

    expect(result).toEqual({ ok: true, changed: 2 });
    expect(store.listChildren('project')).toEqual([b.id, a.id]);
    expect(store.read('project')).toBeNull();
  });

  it('refuses parent changes through update and mutateCard', () => {
    const a = store.create(makeCard({ id: 'goal-a', type: 'goal' }));
    const b = store.create(makeCard({ id: 'goal-b', type: 'goal' }));

    expect(() => store.update(a.id, { parent: b.id })).toThrow(/card reparenting is not supported/i);
    expect(() => store.mutateCard(a.id, { parent: b.id }, ctx)).toThrow(/card reparenting is not supported/i);
  });
});
