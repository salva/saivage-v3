import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('throws when existing children index JSON is invalid', () => {
    store.create(makeCard({ type: 'goal', title: 'Parent' }));
    writeFileSync(
      join(tmpDir, '.saivage', 'cards', 'tree', 'project.children.json'),
      JSON.stringify({ bad: true }, null, 2),
    );
    expect(() => store.listChildren('project')).toThrow(/Card children index .* is invalid/i);
  });
});

describe('CardStore CRUD still works with validated indexes', () => {
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
