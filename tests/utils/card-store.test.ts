import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fsModule from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { CardStoreState } from '../../src/cards/state.js';
import { validateParsedCards } from '../../src/cards/validator.js';
import { parseCard, readHistoryEntriesStrict } from '../../src/persistence/card-loader.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(
  overrides: Partial<CardRecord> & { type: string },
): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'position'> & { id?: string } {
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
    related: [],
    acceptance: '',
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
  } as Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'position'> & { id?: string };
}

let tmpDir: string;
let store: CardStore;

function createRootProject(): CardRecord {
  return store.create(makeCard({ type: 'project', parent: null, depth: 0, title: 'project' }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-cs-'));
  initProjectTree(tmpDir);
  store = new CardStore(tmpDir);
  createRootProject();
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

    const discarded = readdirSync(tmpDir).filter((entry) =>
      entry.startsWith('.saivage.discarded-'),
    );
    expect(discarded).toHaveLength(1);
    expect(existsSync(join(tmpDir, discarded[0], 'legacy-plan.json'))).toBe(true);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'))).toBe(false);
  });
});

describe('CardStore validation of persisted state', () => {
  it('reads a valid persisted card', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Read Me' }));
    const read = store.read(created.id);
    expect(read).not.toBeNull();
    expect(read?.title).toBe('Read Me');
  });

  it('throws when a persisted project card uses a non-canonical id', () => {
    const projectPath = join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json');
    const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as CardRecord;
    rmSync(projectPath);
    writeFileSync(
      join(tmpDir, '.saivage', 'cards', 'by-id', 'root-spec-plan-project.json'),
      JSON.stringify({ ...raw, id: 'root-spec-plan-project' }, null, 2),
    );

    expect(() => {
      store = new CardStore(tmpDir);
    }).toThrow(/expected canonical id 'project'/i);
  });

  it('throws when a persisted project card is not the root card', () => {
    const projectPath = join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json');
    const raw = JSON.parse(readFileSync(projectPath, 'utf-8')) as CardRecord;
    writeFileSync(
      projectPath,
      JSON.stringify({ ...raw, parent: 'goal-parent', depth: 1, position: 1 }, null, 2),
    );

    expect(() => {
      store = new CardStore(tmpDir);
    }).toThrow(/must be the root card/i);
  });

  it('throws when persisted canonical card JSON is schema-invalid on read', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Broken' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    const broken = {
      ...JSON.parse(readFileSync(path, 'utf-8')),
      type: 'not-a-card-type',
    };
    writeFileSync(path, JSON.stringify(broken, null, 2));

    expect(() => {
      store = new CardStore(tmpDir);
    }).toThrow(/Card record .* is invalid|invalid/i);
  });

  it('throws when persisted canonical card JSON is schema-invalid during list', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Broken List' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    const broken = {
      ...JSON.parse(readFileSync(path, 'utf-8')),
      status: 'impossible-status',
    };
    writeFileSync(path, JSON.stringify(broken, null, 2));

    expect(() => {
      store = new CardStore(tmpDir);
    }).toThrow(/Card record .* is invalid|invalid/i);
  });

  it('treats missing optional children index as empty', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Leaf' }));
    expect(store.listChildren(created.id)).toEqual([]);
  });
});

describe('CardStore CRUD still works with validated indexes', () => {
  it('creates the project card with canonical id project', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-cs-project-id-'));
    store = new CardStore(tmpDir);

    const card = store.create(
      makeCard({
        type: 'project',
        parent: null,
        title: 'Root from docs',
      }),
    );

    expect(card.id).toBe('project');
    expect(card.parent).toBeNull();
    expect(card.depth).toBe(0);
    expect(card.position).toBe(0);
    expect(existsSync(join(tmpDir, '.saivage', 'cards', 'by-id', 'project.json'))).toBe(true);
  });

  it('rejects attempts to create a project card under another card', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Parent' }));

    expect(() =>
      store.create(
        makeCard({
          type: 'project',
          parent: goal.id,
          title: 'Nested project',
        }),
      ),
    ).toThrow(/must be the root card/i);
  });

  it('rejects project type changes through mutation', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal' }));

    expect(() =>
      store.mutateCard(
        goal.id,
        { type: 'project' },
        { actor: 'analyst', surface: 'web-chat', reason: 'test' },
      ),
    ).toThrow(/canonical id 'project'|type 'project'/i);
    expect(() =>
      store.mutateCard(
        'project',
        { type: 'goal' },
        { actor: 'analyst', surface: 'web-chat', reason: 'test' },
      ),
    ).toThrow(/canonical project card/i);
  });

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

  it('does not reuse ids reserved by deleted card history', () => {
    const deleted = store.create(makeCard({ type: 'goal', title: 'Deleted' }));
    expect(deleted.id).toBe('card-1');

    store.delete(deleted.id);

    const next = store.create(makeCard({ type: 'goal', title: 'Next' }));
    expect(next.id).toBe('card-2');
  });

  it('does not reuse ids reserved by archived cards', () => {
    const archived = store.create(makeCard({ type: 'goal', title: 'Archived' }));
    expect(archived.id).toBe('card-1');

    store.archiveAndDeleteSubtree([archived.id]);

    const next = store.create(makeCard({ type: 'goal', title: 'Next' }));
    expect(next.id).toBe('card-2');
  });

  it('reserves ids from history after store reload', () => {
    const first = store.create(makeCard({ type: 'goal', title: 'First' }));
    expect(first.id).toBe('card-1');
    store.delete(first.id);

    const reloaded = new CardStore(tmpDir);
    const next = reloaded.create(makeCard({ type: 'goal', title: 'After Reload' }));
    expect(next.id).toBe('card-2');
  });

  it('creates unique sequential ids across stores without read-time invalidation', () => {
    const other = new CardStore(tmpDir);
    const first = store.create(makeCard({ type: 'goal', title: 'First' }));
    const second = other.create(makeCard({ type: 'goal', title: 'Second' }));

    expect(first.id).toBe('card-1');
    expect(second.id).toBe('card-2');
  });

  it('keeps a second store stale until explicit invalidate reloads state', () => {
    const other = new CardStore(tmpDir);
    const created = store.create(makeCard({ type: 'goal', title: 'External' }));

    expect(other.read(created.id)).toBeNull();
    expect(other.list().map((card) => card.id)).toEqual(['project']);

    other.invalidate();

    expect(other.read(created.id)?.title).toBe('External');
  });

  it('invalidates a fresh store without error', () => {
    expect(() => store.invalidate()).not.toThrow();
    expect(store.read('project')?.id).toBe('project');
  });

  it('does not perform filesystem reads on ordinary read methods', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'No read I/O' }));
    const readdirSpy = jest.spyOn(fsModule, 'readdirSync');
    const readFileSpy = jest.spyOn(fsModule, 'readFileSync');

    store.read(created.id);
    store.list();
    store.listChildren('project');
    store.getParent(created.id);
    store.getAncestors(created.id);
    store.getDescendantIds('project');
    store.detectCycles(created.id, []);

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();

    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('derives blocks from depends_on inverse adjacency', () => {
    const dependency = store.create(makeCard({ type: 'goal', title: 'Dependency' }));
    const blocked = store.create(makeCard({ type: 'goal', title: 'Blocked', depends_on: [dependency.id] }));

    expect(store.blocksFor(dependency.id)).toEqual([blocked.id]);
    expect(store.read(dependency.id)).not.toHaveProperty('blocks');
  });

  it('normalizes legacy persisted blocks in card and history rows', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Legacy Blocks' }));
    store.mutateCard(created.id, { title: 'Legacy Blocks Updated' }, { actor: 'analyst', surface: 'web-chat', reason: 'test' });
    const cardPath = join(tmpDir, '.saivage', 'cards', 'by-id', `${created.id}.json`);
    const rawCard = { ...JSON.parse(readFileSync(cardPath, 'utf-8')), blocks: ['legacy-blocker'] };

    const parsedCard = parseCard(rawCard, cardPath);
    expect(parsedCard).not.toHaveProperty('blocks');

    const historyPath = join(tmpDir, '.saivage', 'cards', 'history', `${created.id}.history.jsonl`);
    const rawHistory = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as { snapshot: Record<string, unknown> };
        return JSON.stringify({ ...entry, snapshot: { ...entry.snapshot, blocks: ['legacy-blocker'] } });
      })
      .join('\n') + '\n';
    writeFileSync(historyPath, rawHistory);

    const entries = readHistoryEntriesStrict(historyPath);
    expect(entries[0]!.snapshot).not.toHaveProperty('blocks');
  });

  it('validates parsed cards before CardStoreState construction', () => {
    const invalid = { ...store.read('project')!, id: 'child', type: 'goal' as const, parent: 'missing', depth: 1 };

    expect(() => validateParsedCards({ cards: [invalid], maxDepth: 5 })).toThrow(/missing parent 'missing'/);
  });

  it('allows completed goal cards to retain child evidence on reload', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Completed goal', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Evidence child', parent: goal.id, depth: 2 }));
    const completedAt = '2026-01-01T00:00:00.000Z';

    store.commitTerminalLifecyclePatch(goal.id, {
      status: 'done',
      lifecycle: {
        status: 'done',
        result: {
          kind: 'reviewer_pass',
          planning: { kind: 'planner_done', summary: 'complete' },
          review_summary: 'passed',
          assessment_id: 'assessment-1',
        },
        error: null,
        completed_at: completedAt,
      },
    });

    const reloaded = new CardStore(tmpDir);

    expect(reloaded.read(goal.id)?.status).toBe('done');
    expect(reloaded.listChildren(goal.id)).toEqual([child.id]);
  });

  it('instantiates CardStoreState without filesystem access', () => {
    const readdirSpy = jest.spyOn(fsModule, 'readdirSync');
    const readFileSpy = jest.spyOn(fsModule, 'readFileSync');

    const state = new CardStoreState(5);

    expect(state.list()).toEqual([]);
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();

    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('leaves no group commit marker after a successful reorder', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const c = store.create(makeCard({ type: 'goal', title: 'C', parent: 'project' }));

    store.reorderChildren('project', [c.id, a.id, b.id], {
      actor: 'analyst',
      surface: 'web-chat',
      reason: 'test successful reorder marker cleanup',
    });

    const commitDir = join(tmpDir, '.saivage', 'cards', '.commit');
    const groupMarkers = existsSync(commitDir)
      ? readdirSync(commitDir).filter((name) => name.startsWith('group-'))
      : [];
    expect(groupMarkers).toEqual([]);
  });

  it('keeps sibling positions contiguous after deleting a middle child and after reload', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const c = store.create(makeCard({ type: 'goal', title: 'C', parent: 'project' }));
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    store.delete(b.id);

    const reloaded = new CardStore(tmpDir);
    const positions = reloaded
      .listChildren('project')
      .map((id) => reloaded.read(id)!.position)
      .sort((x, y) => x - y);
    expect(positions).toEqual([0, 1]);
  });
});

describe('CardStore selective patch behavior', () => {
  it('drops no-op fields whose value equals the existing value (active card, depends_on echo)', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Echo', parent: 'project' }));
    store.setStatus(card.id, 'running');
    const before = store.read(card.id)!;
    // Echoing existing depends_on (empty array) together with a real title change must succeed
    // on a running card even though depends_on is a CRITICAL_FIELD that cannot change in 'running'.
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
    store.setStatus(b.id, 'running');
    expect(() =>
      store.mutateCard(
        b.id,
        { depends_on: [a.id] },
        { actor: 'analyst', surface: 'web-chat', reason: 'test' },
      ),
    ).toThrow(/cannot be changed on a card in status 'running'/);
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
  it('keeps version_seq stable for a sibling whose position is unchanged after reorderChildren', () => {
    const parent = store.create(
      makeCard({ type: 'goal', title: 'Stable Parent', parent: 'project' }),
    );
    const first = store.create(makeCard({ type: 'code', title: 'First', parent: parent.id }));
    const stable = store.create(makeCard({ type: 'code', title: 'Stable', parent: parent.id }));
    const third = store.create(makeCard({ type: 'code', title: 'Third', parent: parent.id }));
    const before = store.read(stable.id)!;

    const result = store.reorderChildren(parent.id, [third.id, stable.id, first.id], {
      actor: 'analyst',
      surface: 'web-chat',
      reason: 'test reorder unchanged sibling',
    });

    expect(result).toEqual({ ok: true, changed: 2 });
    expect(store.read(stable.id)!.version_seq).toBe(before.version_seq);
    expect(store.read(stable.id)!.position).toBe(1);
  });

  it('refuses parent changes through mutateCard', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: a.id }));

    expect(() =>
      store.mutateCard(
        child.id,
        { parent: b.id },
        { actor: 'analyst', surface: 'web-chat', reason: 'test reparent' },
      ),
    ).toThrow(/card reparenting is not supported/i);
  });

  it('ignores stale boot-time children snapshots and uses by-id authority', () => {
    // F13 r5: cards/tree/* and cards/index.json no longer exist; by-id is sole authority.
    const realParent = store.create(
      makeCard({ type: 'goal', title: 'Real Parent', parent: 'project' }),
    );
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: realParent.id }));
    store = new CardStore(tmpDir);
    expect(store.listChildren(realParent.id)).toEqual([child.id]);
  });

  it('fails fast for impossible canonical by-id graph states', () => {
    const child = store.create(makeCard({ type: 'goal', title: 'Orphan', parent: 'project' }));
    const path = join(tmpDir, '.saivage', 'cards', 'by-id', `${child.id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CardRecord;
    writeFileSync(path, JSON.stringify({ ...raw, parent: 'missing-parent' }, null, 2));

    expect(() => {
      store = new CardStore(tmpDir);
    }).toThrow(/missing parent 'missing-parent'|parent .* not found/i);
  });

  it('keeps listChildren and descendants consistent without any legacy snapshots', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    const child = store.create(makeCard({ type: 'code', title: 'Child', parent: parent.id }));

    store = new CardStore(tmpDir);

    expect(store.listChildren('project')).toEqual([parent.id]);
    expect(store.listChildren(parent.id)).toEqual([child.id]);
    expect(store.getDescendantIds('project')).toEqual([parent.id, child.id]);
  });

  it('delete and archive scopes are derived from by-id authority alone', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    void parent;
    const leaf = store.create(makeCard({ type: 'code', title: 'Leaf', parent: 'project' }));
    const subtree = store.create(makeCard({ type: 'goal', title: 'Subtree', parent: 'project' }));
    const subtreeChild = store.create(
      makeCard({ type: 'code', title: 'Subtree Child', parent: subtree.id }),
    );

    store = new CardStore(tmpDir);
    expect(() => store.delete(leaf.id)).not.toThrow();

    store.archiveAndDeleteSubtree([subtree.id, subtreeChild.id]);
    expect(store.read(subtree.id)).toBeNull();
    expect(store.read(subtreeChild.id)).toBeNull();
    const archive = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'archive', 'cards', `${subtree.id}.json`), 'utf-8'),
    ) as { children: string[] };
    expect(archive.children).toEqual([subtreeChild.id]);
  });

  it('does not use loadChildren in CardStore semantic readers or destructive traversal', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'cards', 'card-store.ts'), 'utf-8');
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
