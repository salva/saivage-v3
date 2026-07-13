import { ReadModelChangeBroadcaster, type ReadModelChanges } from '../../src/application/read-model-changes.js';
import { ActorSnapshotStore, type ActorSnapshotRecord } from '../../src/runtime/actors/snapshots.js';
import type { CardNotification } from '../../src/runtime/actors/card-actor.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';

export type TestActorSnapshotStore = ActorSnapshotStore & {
  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord;
  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord;
  remove(actorId: string): boolean;
};

export function testActorSnapshots(projectRoot: string, changes: ReadModelChanges = new ReadModelChangeBroadcaster()): TestActorSnapshotStore {
  const composition = createMutationLane();
  const store = new ActorSnapshotStore(projectRoot, composition.lane, changes);
  store.restabilize(composition.authority);
  return new Proxy(store, {
    get(target, property) {
      if (property === 'save') return (first: unknown, second?: unknown) => second === undefined ? target.save(composition.authority, first as ActorSnapshotRecord) : target.save(first as never, second as ActorSnapshotRecord);
      if (property === 'appendNotification') return (first: unknown, second: unknown, third?: unknown) => third === undefined ? target.appendNotification(composition.authority, first as string, second as CardNotification) : target.appendNotification(first as never, second as string, third as CardNotification);
      if (property === 'remove') return (first: unknown, second?: unknown) => second === undefined ? target.remove(composition.authority, first as string) : target.remove(first as never, second as string);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TestActorSnapshotStore;
}
