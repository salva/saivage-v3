import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore, closeTestProject, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { closeTestProject(root); rmSync(root, { recursive: true, force: true }); } });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'canonical-startup-refusal-'));
  roots.push(root);
  initProjectTree(root);
  return { root, store: new CardStore(root) };
}

function rewriteCurrentCard(root: string, cardId: string, version: number, mutate: (artifact: any) => void): void {
  const path = join(root, '.saivage', 'cards', cardId, 'card', 'versions', `${version}.json`);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  mutate(artifact);
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

describe('canonical CardStore startup refusal', () => {
  it('fails rather than skipping a malformed highest canonical card artifact', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Goal', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    closeTestProject(root);
    rewriteCurrentCard(root, card.id, 1, (artifact) => { delete artifact.card.version_seq; });
    expect(() => new CardStore(root)).toThrow(/version_seq|invalid/i);
  });

  it('strictly refuses a non-contiguous canonical sibling order instead of repairing it', () => {
    const { root, store } = setup();
    const first = store.create({ type: 'goal', parent: 'project', title: 'First', brief: 'first', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const second = store.create({ type: 'goal', parent: 'project', title: 'Second', brief: 'second', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    closeTestProject(root);
    rewriteCurrentCard(root, second.id, 1, (artifact) => { artifact.card.position = 3; });
    expect(() => new CardStore(root)).toThrow(/position|contiguous/i);
    expect(readFileSync(join(root, '.saivage', 'cards', first.id, 'card', 'versions', '1.json'), 'utf8')).toContain('"position": 0');
  });

  it('strictly refuses duplicate canonical sibling positions', () => {
    const { root, store } = setup();
    store.create({ type: 'goal', parent: 'project', title: 'First', brief: 'first', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const second = store.create({ type: 'goal', parent: 'project', title: 'Second', brief: 'second', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    closeTestProject(root);
    rewriteCurrentCard(root, second.id, 1, (artifact) => { artifact.card.position = 0; });
    expect(() => new CardStore(root)).toThrow(/position|duplicate/i);
  });

  it('removes only an exact brief-published creation prefix when card version 1 is absent', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Interrupted', brief: 'published brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    closeTestProject(root);
    unlinkSync(join(root, '.saivage', 'cards', card.id, 'card', 'versions', '1.json'));

    const reopened = new CardStore(root);
    expect(reopened.read(card.id)).toBeNull();
    expect(existsSync(join(root, '.saivage', 'cards', card.id))).toBe(false);
  });

  it('does not erase an active namespace whose required brief is missing', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Active', brief: 'published brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    closeTestProject(root);
    unlinkSync(join(root, '.saivage', 'cards', card.id, 'brief', 'versions', '1.json'));

    expect(() => new CardStore(root)).toThrow(/missing a required closed brief/i);
    expect(existsSync(join(root, '.saivage', 'cards', card.id, 'card', 'versions', '1.json'))).toBe(true);
  });

  it('treats retained evidence below a valid tombstone as opaque and keeps the id inactive', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Deleted', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    store.delete(card.id);
    closeTestProject(root);
    const namespace = join(root, '.saivage', 'cards', card.id);
    writeFileSync(join(namespace, 'card', 'versions', '1.json'), '{malformed retained evidence');
    mkdirSync(join(namespace, 'conversations', 'malformed-retained-session'), { recursive: true });
    writeFileSync(join(namespace, 'conversations', 'malformed-retained-session', 'garbage'), 'opaque');

    const reopened = new CardStore(root);
    expect(reopened.read(card.id)).toBeNull();
    expect(reopened.listCardHistory(card.id)).toEqual([]);
    expect(reopened.namespace.isActiveCardId(card.id)).toBe(false);
    expect(() => reopened.readRecord(card.id, 'brief.md')).toThrow(/not found/i);
  });

  it('fails on unknown immediate tombstoned namespace entries', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Deleted', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    store.delete(card.id);
    closeTestProject(root);
    const namespace = join(root, '.saivage', 'cards', card.id);
    writeFileSync(join(namespace, 'unknown-root'), 'invalid ownership');
    expect(() => new CardStore(root)).toThrow(/Unknown card namespace entry/i);
  });

  it('fails on a malformed complete tombstone', () => {
    const { root, store } = setup();
    const card = store.create({ type: 'goal', parent: 'project', title: 'Deleted', brief: 'brief', status: 'backlog', depth: 1, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    store.delete(card.id);
    closeTestProject(root);
    const namespace = join(root, '.saivage', 'cards', card.id);
    writeFileSync(join(namespace, 'tombstone.json'), '{}\n');
    expect(() => new CardStore(root)).toThrow(/tombstone/i);
  });
});
