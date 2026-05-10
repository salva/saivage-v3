import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

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

// ── CRUD Tests ────────────────────────────────────────────────

describe('CardStore.create', () => {
  it('creates a card file in cards/by-id/', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'My Goal' }));
    expect(existsSync(join(tmpDir, '.saivage', 'cards', 'by-id', `${card.id}.json`))).toBe(true);
  });

  it('auto-generates an ID for non-project cards', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Goal 1' }));
    expect(card.id).toMatch(/^goal-\d+$/);
  });

  it('auto-increments IDs based on existing cards', () => {
    const c1 = store.create(makeCard({ type: 'goal', title: 'G1' }));
    const c2 = store.create(makeCard({ type: 'goal', title: 'G2' }));
    const c3 = store.create(makeCard({ type: 'goal', title: 'G3' }));
    expect(c1.id).toBe('goal-1');
    expect(c2.id).toBe('goal-2');
    expect(c3.id).toBe('goal-3');
  });

  it('uses different counters for different types', () => {
    const g = store.create(makeCard({ type: 'goal', title: 'G' }));
    const c = store.create(makeCard({ type: 'code', title: 'C' }));
    expect(g.id).toBe('goal-1');
    expect(c.id).toBe('code-1');
  });

  it('updates card index after creation', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Index Me' }));
    const indexRaw = readFileSync(join(tmpDir, '.saivage', 'cards', 'index.json'), 'utf-8');
    const index = JSON.parse(indexRaw);
    expect(index.cards[card.id]).toBeDefined();
    expect(index.cards[card.id].type).toBe('goal');
    expect(index.cards[card.id].title).toBe('Index Me');
  });

  it('updates parent children list after creation', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Child Goal', parent: 'project' }));
    const children = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'tree', 'project.children.json'), 'utf-8'),
    );
    expect(children).toContain(card.id);
  });

  it('sets depth correctly for project child (depth 1)', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Depth 1', parent: 'project' }));
    expect(card.depth).toBe(1);
  });

  it('sets depth correctly for nested cards', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    const child = store.create(makeCard({ type: 'goal', title: 'Child', parent: parent.id }));
    expect(child.depth).toBe(2);
  });

  it('sets depth to 0 for no parent', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Root-like', parent: null }));
    expect(card.depth).toBe(0);
  });

  it('sets created_at and updated_at', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'TS' }));
    expect(card.created_at).toBeDefined();
    expect(card.updated_at).toBeDefined();
    expect(new Date(card.created_at).getTime()).toBeGreaterThan(0);
  });

  it('accepts user-provided ID', () => {
    const card = store.create(makeCard({ id: 'my-custom-goal', type: 'goal', title: 'Custom ID' }));
    expect(card.id).toBe('my-custom-goal');
  });

  it('sets default fields correctly', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Defaults' }));
    expect(card.blocks).toEqual([]);
    expect(card.artifacts).toEqual([]);
    expect(card.attachments).toEqual([]);
    expect(card.retries).toBe(0);
  });
});

describe('CardStore.read', () => {
  it('returns a card by ID', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Read Me' }));
    const read = store.read(created.id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(created.id);
    expect(read!.title).toBe('Read Me');
  });

  it('returns null for missing cards', () => {
    expect(store.read('nonexistent')).toBeNull();
  });

  it('returns the project card', () => {
    const project = store.read('project');
    expect(project).not.toBeNull();
    expect(project!.type).toBe('project');
    expect(project!.id).toBe('project');
  });
});

describe('CardStore.update', () => {
  it('updates card fields', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Old Title' }));
    const updated = store.update(created.id, { title: 'New Title' });
    expect(updated.title).toBe('New Title');
    expect(updated.id).toBe(created.id);
  });

  it('does not change id or created_at', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Immutable' }));
    const updated = store.update(created.id, { title: 'Changed' });
    expect(updated.id).toBe(created.id);
    expect(updated.created_at).toBe(created.created_at);
  });

  it('updates updated_at timestamp', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Time Test' }));
    const updated = store.update(created.id, { title: 'Changed' });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updated_at).getTime(),
    );
  });

  it('persists changes to disk', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Persist Me' }));
    store.update(created.id, { title: 'Persisted' });
    const fromDisk = store.read(created.id);
    expect(fromDisk!.title).toBe('Persisted');
  });

  it('updates index entry on update', () => {
    const created = store.create(makeCard({ type: 'goal', title: 'Index Update' }));
    store.update(created.id, { title: 'Updated Index' });
    const indexRaw = readFileSync(join(tmpDir, '.saivage', 'cards', 'index.json'), 'utf-8');
    const index = JSON.parse(indexRaw);
    expect(index.cards[created.id].title).toBe('Updated Index');
  });

  it('recomputes blocks when depends_on changes', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Card A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'Card B', parent: 'project' }));
    store.update(b.id, { depends_on: [a.id] });
    const blocksRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      'utf-8',
    );
    const blocks = JSON.parse(blocksRaw);
    expect(blocks[a.id]).toContain(b.id);
  });

  it('throws when updating a nonexistent card', () => {
    expect(() => store.update('nope', { title: 'No' })).toThrow(/not found/);
  });
});

describe('CardStore.delete', () => {
  it('removes the card file', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Delete Me' }));
    const cardFile = join(tmpDir, '.saivage', 'cards', 'by-id', `${card.id}.json`);
    expect(existsSync(cardFile)).toBe(true);
    store.delete(card.id);
    expect(existsSync(cardFile)).toBe(false);
  });

  it('removes card from index', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Index Del' }));
    store.delete(card.id);
    const indexRaw = readFileSync(join(tmpDir, '.saivage', 'cards', 'index.json'), 'utf-8');
    const index = JSON.parse(indexRaw);
    expect(index.cards[card.id]).toBeUndefined();
  });

  it('removes card from parent children list', () => {
    const child = store.create(makeCard({ type: 'goal', title: 'Child Del', parent: 'project' }));
    store.delete(child.id);
    const children = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'tree', 'project.children.json'), 'utf-8'),
    );
    expect(children).not.toContain(child.id);
  });

  it('removes card from depends_on entries', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Dep A', parent: 'project' }));
    store.create(
      makeCard({
        type: 'goal',
        title: 'Dep B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    store.delete(a.id);
    const depsRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'depends-on.json'),
      'utf-8',
    );
    const deps = JSON.parse(depsRaw);
    expect(deps[a.id]).toBeUndefined();
  });

  it('throws when deleting the project card', () => {
    expect(() => store.delete('project')).toThrow(/Cannot delete the project/);
  });

  it('throws when deleting a non-leaf card', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    store.create(makeCard({ type: 'goal', title: 'Child', parent: parent.id }));
    expect(() => store.delete(parent.id)).toThrow(/child/);
  });

  it('throws when deleting a plan card', () => {
    const { plan } = store.activateGoal('project');
    expect(() => store.delete(plan.id)).toThrow(/plan card/);
  });

  it('allows delete after children are removed', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Parent', parent: 'project' }));
    const child = store.create(makeCard({ type: 'goal', title: 'Child', parent: parent.id }));
    store.delete(child.id);
    store.delete(parent.id);
    expect(store.read(parent.id)).toBeNull();
  });

  it('recomputes blocks after delete', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Block A', parent: 'project' }));
    const b = store.create(
      makeCard({
        type: 'goal',
        title: 'Block B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    const blocksBefore = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'), 'utf-8'),
    );
    expect(blocksBefore[a.id]).toContain(b.id);
    store.delete(b.id);
    const blocksAfter = JSON.parse(
      readFileSync(join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'), 'utf-8'),
    );
    expect(blocksAfter[a.id] || []).not.toContain(b.id);
  });
});

describe('CardStore.list / listChildren', () => {
  it('returns all cards including project', () => {
    store.create(makeCard({ type: 'goal', title: 'G1' }));
    store.create(makeCard({ type: 'goal', title: 'G2' }));
    store.create(makeCard({ type: 'code', title: 'C1' }));
    const cards = store.list();
    expect(cards.length).toBe(4);
  });

  it('listChildren returns child IDs', () => {
    const c1 = store.create(makeCard({ type: 'goal', title: 'C1', parent: 'project' }));
    const c2 = store.create(makeCard({ type: 'goal', title: 'C2', parent: 'project' }));
    const children = store.listChildren('project');
    expect(children).toContain(c1.id);
    expect(children).toContain(c2.id);
  });

  it('listChildren returns empty array for leaf nodes', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Lonely' }));
    expect(store.listChildren(card.id)).toEqual([]);
  });
});

// ── Hierarchy Rules ──────────────────────────────────────────

describe('Singleton project', () => {
  it('throws when creating a second project card', () => {
    expect(() =>
      store.create(makeCard({ type: 'project', title: 'Another', parent: null })),
    ).toThrow(/duplicate project card/);
  });

  it('project card exists after init', () => {
    const project = store.read('project');
    expect(project).not.toBeNull();
    expect(project!.type).toBe('project');
  });
});

describe('One plan per goal — activateGoal', () => {
  it('auto-creates a plan card on goal activation', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Test Goal', parent: 'project' }));
    const result = store.activateGoal(goal.id);
    expect(result.goal.status).toBe('active');
    expect(result.plan.type).toBe('plan');
    expect(result.plan.parent).toBe(goal.id);
    expect(result.plan.id).toBe(`plan-${goal.id}`);
  });

  it('auto-creates a plan card on project activation', () => {
    const result = store.activateGoal('project');
    expect(result.goal.status).toBe('active');
    expect(result.plan.type).toBe('plan');
    expect(result.plan.parent).toBe('project');
    expect(result.plan.id).toBe('plan-project');
  });

  it('plan card is the first child', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Plan Parent', parent: 'project' }));
    store.create(makeCard({ type: 'code', title: 'Child 1', parent: goal.id }));
    store.create(makeCard({ type: 'code', title: 'Child 2', parent: goal.id }));
    const result = store.activateGoal(goal.id);
    const children = store.listChildren(goal.id);
    expect(children[0]).toBe(result.plan.id);
  });

  it('is idempotent — no second plan', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Idempotent', parent: 'project' }));
    const first = store.activateGoal(goal.id);
    const second = store.activateGoal(goal.id);
    expect(second.plan.id).toBe(first.plan.id);
  });

  it('plan card depth = goal depth + 1', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Depth Check', parent: 'project' }));
    const result = store.activateGoal(goal.id);
    expect(result.plan.depth).toBe(goal.depth + 1);
  });

  it('plan card has status backlog', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Status Check', parent: 'project' }));
    const result = store.activateGoal(goal.id);
    expect(result.plan.status).toBe('backlog');
  });

  it('throws on non-project, non-goal card', () => {
    const code = store.create(makeCard({ type: 'code', title: 'Code Card', parent: 'project' }));
    expect(() => store.activateGoal(code.id)).toThrow(/requires a project or goal/);
  });
});

describe('Terminal cards', () => {
  const terminalTypes = ['architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] as const;

  for (const termType of terminalTypes) {
    it(`creating child under ${termType} throws`, () => {
      const terminal = store.create(
        makeCard({ type: termType, title: `T-${termType}`, parent: 'project' }),
      );
      expect(() =>
        store.create(makeCard({ type: 'goal', title: 'Child', parent: terminal.id })),
      ).toThrow(/terminal card/i);
    });
  }

  it('changing type to terminal while having children throws', () => {
    const parent = store.create(
      makeCard({ type: 'goal', title: 'Parent Goal', parent: 'project' }),
    );
    store.create(makeCard({ type: 'goal', title: 'Child Goal', parent: parent.id }));
    expect(() => store.update(parent.id, { type: 'code' })).toThrow(
      /terminal cards cannot have children/i,
    );
  });

  it('changing type to terminal without children succeeds', () => {
    const parent = store.create(makeCard({ type: 'goal', title: 'Solo Goal', parent: 'project' }));
    const updated = store.update(parent.id, { type: 'code' });
    expect(updated.type).toBe('code');
  });

  it('changing parent to a terminal card throws', () => {
    const terminal = store.create(makeCard({ type: 'code', title: 'Terminal', parent: 'project' }));
    const other = store.create(makeCard({ type: 'goal', title: 'Other', parent: 'project' }));
    expect(() => store.update(other.id, { parent: terminal.id })).toThrow(/terminal card/i);
  });
});

describe('Plan card manual creation forbidden', () => {
  it('throws on direct plan card creation', () => {
    expect(() =>
      store.create(makeCard({ type: 'plan', title: 'Manual', parent: 'project' })),
    ).toThrow(/cannot be created manually/);
  });

  it('throws on type change to plan', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'NotAPlan', parent: 'project' }));
    expect(() => store.update(goal.id, { type: 'plan' })).toThrow(/cannot change.*plan.*manually/i);
  });
});

// ── Dependency Management ────────────────────────────────────

describe('Depends on / blocks consistency', () => {
  it('blocks is auto-computed from depends_on', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    store.create(
      makeCard({
        type: 'goal',
        title: 'B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    const blocksRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      'utf-8',
    );
    const blocks = JSON.parse(blocksRaw);
    expect(blocks[a.id]).toContain('goal-2');
  });

  it('recomputeBlocks rebuilds from scratch', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const c = store.create(makeCard({ type: 'goal', title: 'C', parent: 'project' }));
    store.update(b.id, { depends_on: [a.id] });
    store.update(c.id, { depends_on: [a.id, b.id] });
    store.recomputeBlocks();
    const blocksRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      'utf-8',
    );
    const blocks = JSON.parse(blocksRaw);
    expect(blocks[a.id]).toContain(b.id);
    expect(blocks[a.id]).toContain(c.id);
    expect(blocks[b.id]).toContain(c.id);
  });

  it('read() returns blocks merged from blocks index after depends_on set', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Card A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'Card B', parent: 'project' }));
    store.update(b.id, { depends_on: [a.id] });
    // read(B).blocks should not include anything (B has no dependents)
    const bCard = store.read(b.id);
    expect(bCard!.blocks).toEqual([]);
    // read(A).blocks should include B (B depends on A, so A blocks B)
    const aCard = store.read(a.id);
    expect(aCard!.blocks).toContain(b.id);
  });

  it('read() returns updated blocks after deleting a blocking card', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Card A', parent: 'project' }));
    const b = store.create(
      makeCard({
        type: 'goal',
        title: 'Card B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    // Before delete: A blocks B
    const aBefore = store.read(a.id);
    expect(aBefore!.blocks).toContain(b.id);

    // Delete B (the dependent card)
    store.delete(b.id);

    // After delete: A should no longer block B (B is gone)
    const aAfter = store.read(a.id);
    expect(aAfter!.blocks).not.toContain(b.id);
  });

  it('read() returns updated blocks after clearing depends_on', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'Card A', parent: 'project' }));
    const b = store.create(
      makeCard({
        type: 'goal',
        title: 'Card B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    // Before update: A blocks B
    const aBefore = store.read(a.id);
    expect(aBefore!.blocks).toContain(b.id);

    // Update B's depends_on to empty
    store.update(b.id, { depends_on: [] });

    // After update: A should no longer block B
    const aAfter = store.read(a.id);
    expect(aAfter!.blocks).not.toContain(b.id);
  });

  it('activateGoal calls recomputeBlocks for consistency', () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Plan Goal', parent: 'project' }));
    const { plan } = store.activateGoal(goal.id);

    // Plan card has empty depends_on, so its blocks should be empty
    const planCard = store.read(plan.id);
    expect(planCard!.blocks).toEqual([]);

    // Verify blocks index has an entry for the plan card
    const blocksRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      'utf-8',
    );
    const blocks = JSON.parse(blocksRaw);
    expect(blocks[plan.id]).toBeDefined();
    expect(blocks[plan.id]).toEqual([]);
  });
});

describe('Cycle detection', () => {
  it('detects direct cycle A -> B -> A', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(
      makeCard({
        type: 'goal',
        title: 'B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    const cycle = store.detectCycles(a.id, [b.id]);
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('detects indirect cycle A -> B -> C -> A', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(
      makeCard({
        type: 'goal',
        title: 'B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    const c = store.create(
      makeCard({
        type: 'goal',
        title: 'C',
        parent: 'project',
        depends_on: [b.id],
      }),
    );
    const cycle = store.detectCycles(a.id, [c.id]);
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('rejects create with a dependency cycle', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    store.create(
      makeCard({
        type: 'goal',
        title: 'B',
        parent: 'project',
        depends_on: [a.id],
      }),
    );
    expect(() => store.update(a.id, { depends_on: ['goal-2'] })).toThrow(/cycle/);
  });

  it('returns empty array for safe dependency', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    const cycle = store.detectCycles(b.id, [a.id]);
    expect(cycle).toEqual([]);
  });

  it('detects self-dependency cycle', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const cycle = store.detectCycles(a.id, [a.id]);
    expect(cycle.length).toBeGreaterThan(0);
  });
});

describe('updateDependsOn', () => {
  it('updates depends_on and recomputes blocks', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    store.updateDependsOn(b.id, [a.id]);
    const updated = store.read(b.id);
    expect(updated!.depends_on).toEqual([a.id]);
    const blocksRaw = readFileSync(
      join(tmpDir, '.saivage', 'cards', 'dependencies', 'blocks.json'),
      'utf-8',
    );
    const blocks = JSON.parse(blocksRaw);
    expect(blocks[a.id]).toContain(b.id);
  });
});

// ── Hierarchy Queries ────────────────────────────────────────

describe('Hierarchy Queries', () => {
  it('getAncestors returns root → parent order', () => {
    const g1 = store.create(makeCard({ type: 'goal', title: 'G1', parent: 'project' }));
    const g2 = store.create(makeCard({ type: 'goal', title: 'G2', parent: g1.id }));
    expect(store.getAncestors(g2.id)).toEqual(['project', g1.id]);
  });

  it('getAncestors returns empty array for project card', () => {
    expect(store.getAncestors('project')).toEqual([]);
  });

  it('getAncestors returns empty array for unknown card', () => {
    expect(store.getAncestors('nope')).toEqual([]);
  });

  it('isDescendantOf returns true for direct child', () => {
    const g = store.create(makeCard({ type: 'goal', title: 'G', parent: 'project' }));
    expect(store.isDescendantOf(g.id, 'project')).toBe(true);
  });

  it('isDescendantOf returns true for nested descendant', () => {
    const g1 = store.create(makeCard({ type: 'goal', title: 'G1', parent: 'project' }));
    const g2 = store.create(makeCard({ type: 'goal', title: 'G2', parent: g1.id }));
    expect(store.isDescendantOf(g2.id, 'project')).toBe(true);
  });

  it('isDescendantOf returns false for unrelated cards', () => {
    const a = store.create(makeCard({ type: 'goal', title: 'A', parent: 'project' }));
    const b = store.create(makeCard({ type: 'goal', title: 'B', parent: 'project' }));
    expect(store.isDescendantOf(a.id, b.id)).toBe(false);
  });

  it('getDescendantIds returns all descendants', () => {
    const g1 = store.create(makeCard({ type: 'goal', title: 'G1', parent: 'project' }));
    const g2 = store.create(makeCard({ type: 'goal', title: 'G2', parent: g1.id }));
    const c1 = store.create(makeCard({ type: 'code', title: 'C1', parent: g2.id }));
    const descendants = store.getDescendantIds(g1.id);
    expect(descendants).toContain(g2.id);
    expect(descendants).toContain(c1.id);
  });

  it('getDescendantIds returns empty array for leaf', () => {
    const card = store.create(makeCard({ type: 'code', title: 'Leaf', parent: 'project' }));
    expect(store.getDescendantIds(card.id)).toEqual([]);
  });
});

// ── Status Transitions ───────────────────────────────────────

describe('Status Transitions', () => {
  it('setStatus updates card status', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Status Test', parent: 'project' }));
    const updated = store.setStatus(card.id, 'active');
    expect(updated.status).toBe('active');
  });

  it('setStatus persists to disk', () => {
    const card = store.create(
      makeCard({ type: 'goal', title: 'Persist Status', parent: 'project' }),
    );
    store.setStatus(card.id, 'running');
    const reloaded = store.read(card.id);
    expect(reloaded!.status).toBe('running');
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe('Edge Cases', () => {
  it('creating card with nonexistent parent throws', () => {
    expect(() =>
      store.create(makeCard({ type: 'goal', title: 'Orphan', parent: 'nonexistent' })),
    ).toThrow(/does not exist/);
  });

  it('read returns fresh data after disk changes', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Fresh', parent: 'project' }));
    const first = store.read(card.id);
    expect(first!.title).toBe('Fresh');
    store.update(card.id, { title: 'Fresh Updated' });
    const second = store.read(card.id);
    expect(second!.title).toBe('Fresh Updated');
  });

  it('handles many cards', () => {
    const count = 20;
    for (let i = 0; i < count; i++) {
      store.create(makeCard({ type: 'code', title: `Code ${i}`, parent: 'project' }));
    }
    expect(store.list().length).toBe(count + 1);
  });

  it('card with no parent has depth 0', () => {
    const card = store.create(makeCard({ type: 'goal', title: 'Root-ish', parent: null }));
    expect(card.depth).toBe(0);
  });
});
