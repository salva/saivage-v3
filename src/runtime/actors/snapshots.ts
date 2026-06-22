import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { actorKindFromId } from './ids.js';
import type { ActorKind } from './ids.js';

export const ACTOR_SNAPSHOT_SCHEMA_VERSION = 1;

const actorSnapshotSchema = z.object({
  actor_id: z.string().min(1),
  actor_kind: z.enum(['supervisor', 'card', 'llm', 'process', 'processor']),
  state_value: z.unknown(),
  context: z.record(z.unknown()),
  updated_at: z.string().datetime(),
});

export type ActorSnapshotRecord = z.infer<typeof actorSnapshotSchema>;

export function actorSnapshotsPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'actors');
}

function actorSnapshotsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', '.lock'), { staleLockAction: 'remove' });
}

export function actorSnapshotPath(projectRoot: string, actorId: string): string {
  if (actorId === 'supervisor') return join(actorSnapshotsPath(projectRoot), 'supervisor.json');
  const actorKind = actorKindFromId(actorId);
  return join(actorSnapshotsPath(projectRoot), actorKind, `${encodeURIComponent(actorId)}.json`);
}

function actorSnapshotFile(projectRoot: string, actorId: string, lock: ProjectLock = actorSnapshotsLock(projectRoot)): AtomicJsonFile<ActorSnapshotRecord> {
  return new AtomicJsonFile(actorSnapshotPath(projectRoot, actorId), actorSnapshotSchema, lock, {
    version: ACTOR_SNAPSHOT_SCHEMA_VERSION,
  });
}

export function readActorSnapshots(projectRoot: string): ActorSnapshotRecord[] {
  const paths = actorSnapshotFilePaths(projectRoot);
  return paths
    .map((path) => {
      const file = new AtomicJsonFile(path, actorSnapshotSchema, actorSnapshotsLock(projectRoot), {
        version: ACTOR_SNAPSHOT_SCHEMA_VERSION,
      });
      const snapshot = file.read();
      assertSnapshotKind(snapshot);
      return snapshot;
    })
    .sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}

export function saveActorSnapshot(projectRoot: string, snapshot: ActorSnapshotRecord): ActorSnapshotRecord[] {
  assertSnapshotKind(snapshot);
  const lock = actorSnapshotsLock(projectRoot);
  const file = actorSnapshotFile(projectRoot, snapshot.actor_id, lock);
  return lock.withLockSync((handle) => {
    file.writeSync(handle, snapshot);
    return readActorSnapshots(projectRoot);
  });
}

export function removeActorSnapshot(projectRoot: string, actorId: string): ActorSnapshotRecord[] {
  const lock = actorSnapshotsLock(projectRoot);
  return lock.withLockSync((handle) => {
    lock.assertOwns(handle);
    const path = actorSnapshotPath(projectRoot, actorId);
    if (existsSync(path)) unlinkSync(path);
    return readActorSnapshots(projectRoot);
  });
}

function actorSnapshotFilePaths(projectRoot: string): string[] {
  const root = actorSnapshotsPath(projectRoot);
  const paths: string[] = [];
  const supervisorPath = join(root, 'supervisor.json');
  if (existsSync(supervisorPath)) paths.push(supervisorPath);
  for (const kind of ['card', 'llm', 'process', 'processor'] as const) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(dir, entry.name));
    }
  }
  return paths;
}

function assertSnapshotKind(snapshot: ActorSnapshotRecord): void {
  const expectedKind: ActorKind = actorKindFromId(snapshot.actor_id);
  if (snapshot.actor_kind !== expectedKind) {
    throw new Error(`Actor snapshot kind mismatch for ${snapshot.actor_id}: expected ${expectedKind}, received ${snapshot.actor_kind}`);
  }
}
