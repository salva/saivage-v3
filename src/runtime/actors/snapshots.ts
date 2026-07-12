import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AtomicJsonFile, ProjectLock } from '../../persistence/index.js';
import { actorSnapshotsLockFile, saivageCardsRoot } from '../../persistence/layout.js';
import { actorKindFromId, parseCardActorId, parseLlmActorId, parseProcessorActorId } from './ids.js';
import { actorKindSchema } from '../../schemas/actor-vocabulary.js';
import type { ActorKind } from './ids.js';
import type { CardNotification } from './card-actor.js';
import type { ReadModelChanges } from '../../application/read-model-changes.js';

export const ACTOR_SNAPSHOT_SCHEMA_VERSION = 1;

const actorSnapshotSchema = z.object({
  actor_id: z.string().min(1),
  actor_kind: actorKindSchema,
  state_value: z.unknown(),
  context: z.record(z.unknown()),
  updated_at: z.string().datetime(),
});

export type ActorSnapshotRecord = z.infer<typeof actorSnapshotSchema>;

function actorSnapshotsLock(projectRoot: string): ProjectLock {
  return new ProjectLock(actorSnapshotsLockFile(projectRoot), { staleLockAction: 'remove' });
}

export function actorSnapshotPath(projectRoot: string, actorId: string): string {
  const actorKind = actorKindFromId(actorId);
  const encodedActorId = `${encodeURIComponent(actorId)}.json`;
  if (actorKind === 'card') {
    return join(cardActorSnapshotsRoot(projectRoot, parseCardActorId(actorId), 'card'), encodedActorId);
  }
  if (actorKind === 'processor') {
    return join(cardActorSnapshotsRoot(projectRoot, parseProcessorActorId(actorId), 'processor'), encodedActorId);
  }
  const parsed = parseLlmActorId(actorId);
  if (parsed.cardId) return join(cardActorSnapshotsRoot(projectRoot, parsed.cardId, 'llm'), encodedActorId);
  return join(analystActorSnapshotsRoot(projectRoot), encodedActorId);
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

export function readActorSnapshot(projectRoot: string, actorId: string): ActorSnapshotRecord | null {
  const path = actorSnapshotPath(projectRoot, actorId);
  if (!existsSync(path)) return null;
  const file = actorSnapshotFile(projectRoot, actorId);
  const snapshot = file.read();
  assertSnapshotKind(snapshot);
  return snapshot;
}

export class ActorSnapshotStore {
  constructor(private readonly projectRoot: string, private readonly changes: ReadModelChanges) {}

  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord {
    assertSnapshotKind(snapshot);
    const lock = actorSnapshotsLock(this.projectRoot);
    const file = actorSnapshotFile(this.projectRoot, snapshot.actor_id, lock);
    const saved = lock.withLockSync((handle) => {
      file.writeSync(handle, snapshot);
      return snapshot;
    });
    this.publish(snapshot.actor_kind, snapshot.actor_id);
    return saved;
  }

  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord {
    if (actorKindFromId(actorId) !== 'card') throw new Error(`Cannot append card notification to non-card actor '${actorId}'.`);
    const lock = actorSnapshotsLock(this.projectRoot);
    const file = actorSnapshotFile(this.projectRoot, actorId, lock);
    const saved = lock.withLockSync((handle) => {
      lock.assertOwns(handle);
      const existing = existsSync(file.path) ? file.read() : null;
      if (existing) assertSnapshotKind(existing);
      const context = existing?.context ?? { projectRoot: this.projectRoot, cardId: parseCardActorId(actorId) };
      const notifications = Array.isArray(context.notifications) ? context.notifications : [];
      const snapshot: ActorSnapshotRecord = {
        actor_id: actorId,
        actor_kind: 'card',
        state_value: existing?.state_value ?? null,
        context: { ...context, notifications: [...notifications, notification] },
        updated_at: new Date().toISOString(),
      };
      file.writeSync(handle, snapshot);
      return snapshot;
    });
    this.changes.runtimeChanged();
    return saved;
  }

  remove(actorId: string): boolean {
    const kind = actorKindFromId(actorId);
    const lock = actorSnapshotsLock(this.projectRoot);
    const removed = lock.withLockSync((handle) => {
      lock.assertOwns(handle);
      const path = actorSnapshotPath(this.projectRoot, actorId);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    });
    if (removed) this.publish(kind, actorId);
    return removed;
  }

  private publish(kind: ActorKind, actorId: string): void {
    this.changes.runtimeChanged();
    if (kind !== 'llm') return;
    this.changes.agentsChanged();
    this.changes.conversationChanged(actorId);
  }
}

function actorSnapshotFilePaths(projectRoot: string): string[] {
  const paths: string[] = [];
  collectSnapshotFiles(analystActorSnapshotsRoot(projectRoot), paths);

  const cardsRoot = saivageCardsRoot(projectRoot);
  if (existsSync(cardsRoot)) {
    for (const cardEntry of readdirSync(cardsRoot, { withFileTypes: true })) {
      if (!cardEntry.isDirectory()) continue;
      for (const kind of ['card', 'llm', 'processor'] as const) {
        collectSnapshotFiles(cardActorSnapshotsRoot(projectRoot, cardEntry.name, kind), paths);
      }
    }
  }
  return paths;
}

function analystActorSnapshotsRoot(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'agents', 'runtime', 'actors', 'llm');
}

function cardActorSnapshotsRoot(projectRoot: string, cardId: string, kind: ActorKind): string {
  return join(saivageCardsRoot(projectRoot), cardId, 'runtime', 'actors', kind);
}

function collectSnapshotFiles(dir: string, paths: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(dir, entry.name));
  }
}

function assertSnapshotKind(snapshot: ActorSnapshotRecord): void {
  const expectedKind: ActorKind = actorKindFromId(snapshot.actor_id);
  if (snapshot.actor_kind !== expectedKind) {
    throw new Error(`Actor snapshot kind mismatch for ${snapshot.actor_id}: expected ${expectedKind}, received ${snapshot.actor_kind}`);
  }
}
