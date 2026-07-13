import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMutationLane } from '../../src/application/mutation-lane.js';
import { RootCurrentness } from '../../src/application/mutation-authority.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { CardStoreRepository } from '../../src/cards/card-store.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../../src/persistence/project-identity-store.js';
import { createProjectPersistenceAuthority } from '../../src/persistence/project-persistence-authority.js';
import { acquireRuntimeLifecycleLock, bindRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';

const roots: string[] = [];
const locks: RuntimeLifecycleLockHandle[] = [];

afterEach(() => {
  for (const lock of locks.splice(0)) try { releaseRuntimeLifecycleLock(lock); } catch { /* test may release */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openProject() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-authority-'));
  roots.push(root);
  const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
  locks.push(lock);
  const mutation = createMutationLane();
  const identity = new ProjectIdentityStore(root, mutation.lane, mutation.authority).create('Card authority test');
  bindRuntimeLifecycleLock(lock, projectIdentityDigest(identity));
  const persistence = createProjectPersistenceAuthority({
    projectRoot: root,
    lane: mutation.lane,
    compositionAuthority: mutation.authority,
    mode: { kind: 'bootstrap', root: newProjectRootInput(root) },
  });
  const repository = new CardStoreRepository({ projectRoot: root, reader: persistence.reader, writer: persistence.writer });
  return { root, mutation, persistence, repository };
}

describe('card and authored-record persistence authority', () => {
  it('applies a complete card plus authored-record request through one shared lane', () => {
    const { root, mutation, repository } = openProject();
    const store = repository.authorize(() => mutation.authority);
    const card = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', brief: '# Goal', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });

    store.runPersistenceRequest(() => {
      const open = store.openRecord(card.id, 'status.md');
      store.editRecord(card.id, 'status.md', open.version, 'status evidence');
      store.closeRecord(card.id, 'status.md', open.version, 'planner', card.version_seq);
      store.mutateCard(card.id, { priority: 2 }, { actor: 'planner', surface: 'runtime', reason: 'composite' });
    });

    expect(store.read(card.id)?.priority).toBe(2);
    expect(store.readRecord(card.id, 'status.md').artifact.content).toBe('status evidence');
    expect(existsSync(join(root, '.saivage', 'cards', card.id, 'card', 'versions', '2.json'))).toBe(true);
  });

  it('rejects a stale root-plus-leaf authority before changing canonical bytes', () => {
    const { root, repository } = openProject();
    const roots = new RootCurrentness();
    const rootAuthority = roots.installRoot();
    const leaf = roots.installLeaf(rootAuthority);
    const store = repository.authorize(() => leaf);
    const before = readFileSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json'));
    roots.clearLeaf(leaf);

    expect(() => store.setStatus('project', 'running')).toThrow(/authority is stale/);
    expect(readFileSync(join(root, '.saivage', 'cards', 'project', 'card', 'versions', '1.json'))).toEqual(before);
    expect(store.read('project')?.status).toBe('backlog');
  });

  it('exposes no writer close lifecycle or authority-free repository mutator', () => {
    const { persistence, repository } = openProject();
    expect('close' in persistence).toBe(false);
    expect(() => repository.create({} as never, {} as never)).toThrow(/foreign or invalid/);
  });

  it('gives executor and reviewer record capabilities no card-tree mutation methods', () => {
    const { mutation, repository } = openProject();
    const records = repository.authorize(() => mutation.authority).records() as unknown as Record<string, unknown>;
    for (const method of ['create', 'update', 'mutateCard', 'setStatus', 'commitTerminalLifecyclePatch', 'reorderChildren', 'delete', 'archiveAndDeleteSubtree']) {
      expect(records[method]).toBeUndefined();
    }
    expect(typeof records['openRecord']).toBe('function');
    expect(typeof records['closeRecord']).toBe('function');
  });
});
