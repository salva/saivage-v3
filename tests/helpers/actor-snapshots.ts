import { ReadModelChangeBroadcaster, type ReadModelChanges } from '../../src/application/read-model-changes.js';
import { ActorSnapshotStore, type ActorSnapshotRecord } from '../../src/runtime/actors/snapshots.js';
import type { CardNotification } from '../../src/runtime/actors/card-actor.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type TestActorSnapshotStore = ActorSnapshotStore & {
  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord;
  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord;
  remove(actorId: string): boolean;
};

export function testActorSnapshots(projectRoot: string, changes: ReadModelChanges = new ReadModelChangeBroadcaster()): TestActorSnapshotStore {
  const namespace = {
    activeCardIds: () => {
      const root = join(projectRoot, '.saivage', 'cards');
      return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
    },
    isActiveCardId: (_cardId: string) => true,
  };
  const store = new ActorSnapshotStore(projectRoot, new ApplicationPersistenceHealth(), changes, namespace);
  store.restabilize();
  return store;
}
