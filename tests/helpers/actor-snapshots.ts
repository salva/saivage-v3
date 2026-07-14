import { ReadModelChangeBroadcaster, type ReadModelChanges } from '../../src/application/read-model-changes.js';
import { ActorSnapshotStore, type ActorSnapshotRecord } from '../../src/runtime/actors/snapshots.js';
import type { CardNotification } from '../../src/runtime/actors/card-actor.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';

export type TestActorSnapshotStore = ActorSnapshotStore & {
  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord;
  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord;
  remove(actorId: string): boolean;
};

export function testActorSnapshots(projectRoot: string, changes: ReadModelChanges = new ReadModelChangeBroadcaster()): TestActorSnapshotStore {
  const store = new ActorSnapshotStore(projectRoot, new ApplicationPersistenceHealth(), changes);
  store.restabilize();
  return store;
}
