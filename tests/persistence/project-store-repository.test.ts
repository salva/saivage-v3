import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { newProjectRootInput } from '../../src/boot/app.js';
import { CardStore, CardStoreRepository } from '../../src/cards/card-store.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../../src/persistence/project-identity-store.js';
import { createProjectStoreRepository } from '../../src/persistence/project-store-repository.js';
import { acquireRuntimeLifecycleLock, bindRuntimeLifecycleLock, releaseRuntimeLifecycleLock, type RuntimeLifecycleLockHandle } from '../../src/runtime/lock.js';

const roots: string[] = [];
const locks: RuntimeLifecycleLockHandle[] = [];

afterEach(() => {
  for (const lock of locks.splice(0)) try { releaseRuntimeLifecycleLock(lock); } catch { /* test may release */ }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openProject() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-repository-'));
  roots.push(root);
  const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'init' });
  locks.push(lock);
  const persistenceHealth = new ApplicationPersistenceHealth();
  const identity = new ProjectIdentityStore(root, persistenceHealth).create('Card repository test');
  bindRuntimeLifecycleLock(lock, projectIdentityDigest(identity));
  const persistence = createProjectStoreRepository({
    projectRoot: root,
    persistenceHealth,
    mode: { kind: 'bootstrap', root: newProjectRootInput(root) },
  });
  const repository = new CardStoreRepository({ projectRoot: root, reader: persistence.reader, writer: persistence.writer });
  return { root, persistence, repository };
}

describe('card and authored-record repository', () => {
  it('applies direct synchronous card and authored-record writes', () => {
    const { root, repository } = openProject();
    const card = repository.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', brief: '# Goal', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 });
    const open = repository.openRecord(card.id, 'status.md');
    repository.editRecord(card.id, 'status.md', open.version, 'status evidence');
    repository.closeRecord(card.id, 'status.md', open.version, 'planner', card.version_seq);
    repository.mutateCard(card.id, { priority: 2 }, { actor: 'planner', surface: 'runtime', reason: 'direct writes' });

    expect(repository.read(card.id)?.priority).toBe(2);
    expect(repository.readRecord(card.id, 'status.md').artifact.content).toBe('status evidence');
    expect(existsSync(join(root, '.saivage', 'cards', card.id, 'card', 'versions', '2.json'))).toBe(true);
  });

  it('exposes no writer lifecycle or generic persistence request callback', () => {
    const { persistence, repository } = openProject();
    expect('close' in persistence).toBe(false);
    expect('runPersistenceRequest' in repository).toBe(false);
    expect('authorize' in repository).toBe(false);
  });

  it('keeps record capabilities free of card-tree mutation methods', () => {
    const { repository } = openProject();
    const records = new CardStore(repository).records() as unknown as Record<string, unknown>;
    for (const method of ['create', 'update', 'mutateCard', 'setStatus', 'commitTerminalLifecyclePatch', 'reorderChildren', 'delete', 'archiveAndDeleteSubtree']) {
      expect(records[method]).toBeUndefined();
    }
    expect(typeof records['openRecord']).toBe('function');
    expect(typeof records['closeRecord']).toBe('function');
  });
});
