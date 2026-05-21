import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(
  overrides: Partial<CardRecord> & { type: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id'> & { id?: string } {
  const defaults: Record<string, unknown> = {
    parent: 'project',
    depth: 1,
    title: 'Test Card',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    subtype: null,
    assigned_to: null,
    result: null,
    metrics: null,
    estimate: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
  };

  return {
    ...defaults,
    ...overrides,
  } as Omit<CardRecord, 'created_at' | 'updated_at' | 'id'> & { id?: string };
}

let tmpDir: string;
let store: CardStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-cs-'));
  initProjectTree(tmpDir);
  store = new CardStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Clean-slate boot', () => {
  it('moves legacy .saivage state aside and starts from empty v3 schema', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-clean-slate-'));
    mkdirSync(join(tmpDir, '.saivage', 'cards'), { recursive: true });
    writeFileSync(join(tmpDir, '.saivage', 'legacy-plan.json'), JSON.stringify({ old: true }));

    initProjectTree(tmpDir);
    store = new CardStore(tmpDir);

    const discarded = readdirSync(tmpDir).filter((entry) => entry.startsWith('.saivage.discarded-'));
    expect(discarded).toHaveLength(1);
    expect(existsSync(join(tmpDir, discarded[0], 'legacy-plan.json'))).toBe(true);
    expect(store.list().map((card) => card.id)).toEqual(['project']);
    expect(existsSync(join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'))).toBe(true);
  });
});

describe('CardStore validation of persisted state', () => {
  it('reads a valid persisted card', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Read Me' }));
    const read = store.read(created.id);
    expect(read).not.toBeNull();
    expect(read?.title).toBe('Read Me');
  });

  it('throws when persisted canonical card JSON is schema-invalid on read', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Broken' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    const broken = {
      ...JSON.parse(readFileSync(path, 'utf-8')),
      type: 'not-a-card-type',
    };
    writeFileSync(path, JSON.stringify(broken, null, 2));

    expect(() => store.read(created.id)).toThrow(/Card record .* is invalid/i);
  });

  it('throws when persisted canonical card JSON is schema-invalid during list', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Broken List' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    const broken = {
      ...JSON.parse(readFileSync(path, 'utf-8')),
      status: 'impossible-status',
    };
    writeFileSync(path, JSON.stringify(broken, null, 2));

    expect(() => store.list()).toThrow(/Card record .* is invalid/i);
  });

  it('throws when card index JSON is invalid', () => {
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'index.json'), JSON.stringify({ cards: [] }, null, 2));
    expect(() => store.list()).toThrow(/Card index .* is invalid/i);
  });

  it('throws when dependency index JSON is invalid', () => {
    writeFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'depends-on.json'),
      JSON.stringify({ project: 'goal-1' }, null, 2),
    );
    expect(() => store.recomputeBlocks()).toThrow(/Card dependency index .* is invalid/i);
  });

  it('throws when blocks index JSON is invalid during read', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Broken Blocks' }));
    writeFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      JSON.stringify({ [created.id]: 'goal-2' }, null, 2),
    );
    expect(() => store.read(created.id)).toThrow(/Card blocks index .* is invalid/i);
  });

  it('treats missing optional children index as empty', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Leaf' }));
    expect(store.listChildren(created.id)).toEqual([]);
  });

  it('repairs malformed compatibility children snapshots without using them as semantic authority', () => {
    const child = store.create(makeCard({ type: 'goal', title: 'Parent' }));
    writeFileSync(
      join(tmpDir, '.saivage', 'cards', 'tree', 'project.children.json'),
      JSON.stringify({ bad: true }, null, 2),
    );
    store = new CardStore(tmpDir);
    expect(store.listChildren('project')).toEqual([child.id]);
    const backups = readdirSync(join(tmpDir, '.saivage', 'cards', 'tree-repair-backups'));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe('CardStore CRUD still works with validated indexes', () => {
  it('stores nullable status_text fields on new cards by default', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Null status text defaults' }));
    expect(card.status_text).toBeNull();
    expect(card.status_text_updated_at).toBeNull();
    expect(card.status_text_author_session_id).toBeNull();
    expect(card.latest_self_report).toBeNull();
  });

  it('creates a card file in cards/by-id/', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'My Goal' }));
    expect(existsSync(join(tmpDir, '.saivage', 'cards', 'by-id', `${card.id}.json`))).toBe(true);
  });

  it('updates card index after creation', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Index Me' }));
    const index = JSON.parse(readFileSync(join(tmpDir, '.saivage', 'cards', 'index.json'), 'utf-8'));
    expect(index.cards[card.id]).toBeDefined();
    expect(index.cards[card.id].type).toBe('goal');
  });

  it('merges computed blocks from blocks index on read', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project', depends_on: [a.id] }));
    expect(store.read(a.id)?.blocks).toContain(b.id);
    expect(store.read(b.id)?.blocks).toEqual([]);
  });
});

describe('CardStore selective patch behavior', () => {
  it('drops no-op fields whose value equals the existing value (active card, depends_on echo)', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Echo', parent: 'project' }));
    store.setStatus(card.id, 'active');
    const before = store.read(card.id)!;
    // Echoing existing depends_on (empty array) together with a real title change must succeed
    // on an active card even though depends_on is a CRITICAL_FIELD that cannot change in 'active'.
    const updated = store.mutateCard(
      card.id,
      { title: 'Echo renamed', depends_on: [] },
      { actor: 'analyst', surface: 'web-chat', reason: 'test' },
    );
    expect(updated.title).toBe('Echo renamed');
    expect(updated.version_seq).toBe(before.version_seq + 1);
    const history = store.listCardHistory(card.id);
    expect(history[0]!.changed_fields).toEqual(['title']);
  });

  it('rejects only when a CRITICAL_FIELD actually changes on a status-locked card', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    store.setStatus(b.id, 'active');
    expect(() =>
      store.mutateCard(
        b.id,
        { depends_on: [a.id] },
        { actor: 'analyst', surface: 'web-chat', reason: 'test' },
      ),
    ).toThrow(/cannot be changed on a card in status 'active'/);
  });

  it('returns the existing card unchanged when every passed field is a no-op', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Same', parent: 'project' }));
    const result = store.mutateCard(
      card.id,
      { title: 'Same', depends_on: [] },
      { actor: 'analyst', surface: 'web-chat', reason: 'test' },
    );
    expect(result.version_seq).toBe(card.version_seq);
    expect(result.updated_at).toBe(card.updated_at);
    expect(store.listCardHistory(card.id)).toHaveLength(0);
  });
});


describe('ARCH-026 hierarchy graph authority', () => {
  function readChildren(parentId: string): string[] {
    return JSON.parse(readFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${parentId}.children.json`), 'utf-8')) as string[];
  }

  it('cleans up create-then-reparent snapshots and graph reads', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: a.id }));

    store.mutateCard(child.id, { parent: b.id }, { actor: 'analyst', surface: 'web-chat', reason: 'test reparent' });

    expect(store.read(child.id)?.parent).toBe(b.id);
    expect(store.listChildren(a.id)).not.toContain(child.id);
    expect(store.listChildren(b.id)).toContain(child.id);
    expect(store.getDescendantIds(a.id)).not.toContain(child.id);
    expect(readChildren(a.id)).not.toContain(child.id);
    expect(readChildren(b.id)).toContain(child.id);
  });

  it('ignores and repairs duplicate/stale boot-time children snapshot memberships from by-id authority', () => {
    const realParent = store.create(makeCard({ type: 'goal', title: 'Real Parent', parent: 'project' }));
    const staleParent = store.create(makeCard({ type: 'goal', title: 'Stale Parent', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: realParent.id }));
    const before = readFileSync(join(tmpDir, '.saivage', 'cards', 'by-id', `${child.id}.json`), 'utf-8');
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${staleParent.id}.children.json`), JSON.stringify([child.id], null, 2));
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${realParent.id}.children.json`), JSON.stringify([child.id, child.id], null, 2));

    store = new CardStore(tmpDir);

    expect(store.listChildren(realParent.id)).toEqual([child.id]);
    expect(store.listChildren(staleParent.id)).toEqual([]);
    expect(store.getDescendantIds(staleParent.id)).toEqual([]);
    expect(readChildren(realParent.id)).toEqual([child.id]);
    expect(readChildren(staleParent.id)).toEqual([]);
    expect(readFileSync(join(tmpDir, '.saivage', 'cards', 'by-id', `${child.id}.json`), 'utf-8')).toBe(before);
    const backupRoots = readdirSync(join(tmpDir, '.saivage', 'cards', 'tree-repair-backups'));
    expect(backupRoots.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(tmpDir, '.saivage', 'cards', 'tree-repair-backups', backupRoots[0], 'manifest.json'), 'utf-8')) as { issues: Array<{ code: string }> };
    expect(manifest.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['duplicate-tree-membership', 'stale-tree-membership']));
  });

  it('fails fast for impossible canonical by-id/index graph states', () => {
    const child = store.create(makeCard({ type: 'goal', title: 'Orphan', parent: 'project' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${child.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CardRecord;
    writeFileSync(path, JSON.stringify({ ...raw, parent: 'missing-parent' }, null, 2));

    store = new CardStore(tmpDir);
    expect(() => store.list()).toThrow(/index\.json entry .* does not match by-id record|missing parent 'missing-parent'/i);
  });

  it('keeps listChildren and descendants independent from stale snapshots', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: parent.id }));
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', 'project.children.json'), JSON.stringify([parent.id, child.id, 'ghost'], null, 2));
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${parent.id}.children.json`), JSON.stringify([], null, 2));

    store = new CardStore(tmpDir);

    expect(store.listChildren('project')).toEqual([parent.id]);
    expect(store.listChildren(parent.id)).toEqual([child.id]);
    expect(store.getDescendantIds('project')).toEqual([parent.id, child.id]);
  });

  it('delete and archive scopes are graph-derived rather than expanded or blocked by stale snapshots', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    const leaf = store.create(makeCard({ type: 'code', title: 'Leaf', parent: 'project' }));
    const subtree = store.create(makeCard({ type: 'goal', title: 'Subtree', parent: 'project' }));
    const subtreeChild = store.create(makeCard({ type: 'code', title: 'Subtree Child', parent: subtree.id }));
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${leaf.id}.children.json`), JSON.stringify([parent.id], null, 2));
    writeFileSync(join(tmpDir, '.saivage', 'cards', 'tree', `${subtree.id}.children.json`), JSON.stringify([], null, 2));

    store = new CardStore(tmpDir);
    expect(() => store.delete(leaf.id)).not.toThrow();
    expect(store.read(parent.id)).not.toBeNull();

    store.archiveAndDeleteSubtree([subtree.id, subtreeChild.id]);
    expect(store.read(subtree.id)).toBeNull();
    expect(store.read(subtreeChild.id)).toBeNull();
    const archive = JSON.parse(readFileSync(join(tmpDir, '.saivage', 'archive', 'cards', `${subtree.id}.json`), 'utf-8')) as { children: string[] };
    expect(archive.children).toEqual([subtreeChild.id]);
  });

  it('does not use loadChildren in CardStore semantic readers or destructive traversal', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'utils', 'card-store.ts'), 'utf-8');
    function methodBody(name: string): string {
      const start = source.indexOf(`  ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = source.indexOf('\n  ', source.indexOf('\n', start) + 1);
      return source.slice(start, next === -1 ? undefined : next);
    }
    for (const name of ['listChildren', 'getDescendantIds', 'archiveAndDeleteSubtree', 'delete']) {
      expect(methodBody(name)).not.toContain('loadChildren(');
    }
  });
});
