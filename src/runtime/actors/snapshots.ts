import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { actorKindFromId } from './ids.js';
import type { ActorKind } from './ids.js';

export const ACTOR_SNAPSHOT_SCHEMA_VERSION = 1;

const actorSnapshotSchema = z.object({
  actor_id: z.string().min(1),
  actor_kind: z.enum(['supervisor', 'card', 'llm', 'process']),
  state_value: z.unknown(),
  context: z.record(z.unknown()),
  updated_at: z.string().datetime(),
});

const actorSnapshotFileSchema = z.array(actorSnapshotSchema);

export type ActorSnapshotRecord = z.infer<typeof actorSnapshotSchema>;

export function actorSnapshotsPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'tmp', 'state', 'actors.json');
}

function actorSnapshotsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'), { staleLockAction: 'remove' });
}

function actorSnapshotsFile(projectRoot: string): AtomicJsonFile<ActorSnapshotRecord[]> {
  return new AtomicJsonFile(actorSnapshotsPath(projectRoot), actorSnapshotFileSchema, actorSnapshotsLock(projectRoot), {
    version: ACTOR_SNAPSHOT_SCHEMA_VERSION,
  });
}

export function readActorSnapshots(projectRoot: string): ActorSnapshotRecord[] {
  const path = actorSnapshotsPath(projectRoot);
  if (!existsSync(path)) return [];
  return actorSnapshotsFile(projectRoot).read();
}

export function saveActorSnapshot(projectRoot: string, snapshot: ActorSnapshotRecord): ActorSnapshotRecord[] {
  const expectedKind: ActorKind = actorKindFromId(snapshot.actor_id);
  if (snapshot.actor_kind !== expectedKind) {
    throw new Error(`Actor snapshot kind mismatch for ${snapshot.actor_id}: expected ${expectedKind}, received ${snapshot.actor_kind}`);
  }
  const lock = actorSnapshotsLock(projectRoot);
  const file = new AtomicJsonFile(actorSnapshotsPath(projectRoot), actorSnapshotFileSchema, lock, {
    version: ACTOR_SNAPSHOT_SCHEMA_VERSION,
  });
  return lock.withLockSync((handle) => {
    const current = existsSync(actorSnapshotsPath(projectRoot)) ? file.read() : [];
    const next = [...current.filter((item) => item.actor_id !== snapshot.actor_id), snapshot]
      .sort((a, b) => a.actor_id.localeCompare(b.actor_id));
    file.writeSync(handle, next);
    return next;
  });
}

export function removeActorSnapshot(projectRoot: string, actorId: string): ActorSnapshotRecord[] {
  const lock = actorSnapshotsLock(projectRoot);
  const file = new AtomicJsonFile(actorSnapshotsPath(projectRoot), actorSnapshotFileSchema, lock, {
    version: ACTOR_SNAPSHOT_SCHEMA_VERSION,
  });
  return lock.withLockSync((handle) => {
    const current = existsSync(actorSnapshotsPath(projectRoot)) ? file.read() : [];
    const next = current.filter((item) => item.actor_id !== actorId);
    file.writeSync(handle, next);
    return next;
  });
}
