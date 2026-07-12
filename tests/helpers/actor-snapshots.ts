import { ReadModelChangeBroadcaster, type ReadModelChanges } from '../../src/application/read-model-changes.js';
import { ActorSnapshotStore } from '../../src/runtime/actors/snapshots.js';

export function testActorSnapshots(projectRoot: string, changes: ReadModelChanges = new ReadModelChangeBroadcaster()): ActorSnapshotStore {
  return new ActorSnapshotStore(projectRoot, changes);
}
