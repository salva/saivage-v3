import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { saivageCardsRoot } from '../../persistence/layout.js';
import { cleanupDurableReplacementTemporaries, durableReplacementTemporaryTargetBasename, durablyReplaceFile } from '../../persistence/durable-file-replacement.js';
import type { ApplicationPersistenceHealth } from '../../application/persistence-health.js';
import { actorKindFromId, parseCardActorId, parseLlmActorId, parseProcessorActorId } from './ids.js';
import { actorKindSchema } from '../../schemas/actor-vocabulary.js';
import type { ActorKind } from './ids.js';
import type { CardNotification } from './card-actor.js';
import type { ReadModelChanges } from '../../application/read-model-changes.js';
import type { ProjectNamespaceReader } from '../../persistence/project-store-repository.js';

export const ACTOR_SNAPSHOT_SCHEMA_VERSION = 1;

const actorSnapshotSchema = z.object({
  actor_id: z.string().min(1),
  actor_kind: actorKindSchema,
  state_value: z.unknown(),
  context: z.record(z.unknown()),
  updated_at: z.string().datetime(),
});

export type ActorSnapshotRecord = z.infer<typeof actorSnapshotSchema>;

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

export function readActiveActorSnapshots(projectRoot: string, namespace: ProjectNamespaceReader): ActorSnapshotRecord[] {
  const paths = actorSnapshotFilePaths(projectRoot, namespace);
  return paths
    .map((path) => {
      const snapshot = readSnapshotFile(path);
      assertSnapshotKind(snapshot);
      return snapshot;
    })
    .sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}

export function readActiveActorSnapshot(projectRoot: string, actorId: string, namespace: ProjectNamespaceReader): ActorSnapshotRecord | null {
  assertActiveActorCard(actorId, namespace);
  const path = actorSnapshotPath(projectRoot, actorId);
  if (!existsSync(path)) return null;
  const snapshot = readSnapshotFile(path);
  assertSnapshotKind(snapshot);
  return snapshot;
}

export function readActorSnapshots(projectRoot: string): ActorSnapshotRecord[] {
  const paths: string[] = [];
  collectSnapshotFiles(analystActorSnapshotsRoot(projectRoot), paths);
  const cardsRoot = saivageCardsRoot(projectRoot);
  if (existsSync(cardsRoot)) for (const entry of readdirSync(cardsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    for (const kind of ['card', 'llm', 'processor'] as const) collectSnapshotFiles(cardActorSnapshotsRoot(projectRoot, entry.name, kind), paths);
  }
  return paths.map(readSnapshotFile).sort((left, right) => left.actor_id.localeCompare(right.actor_id));
}

export function readActorSnapshot(projectRoot: string, actorId: string): ActorSnapshotRecord | null {
  const path = actorSnapshotPath(projectRoot, actorId);
  return existsSync(path) ? readSnapshotFile(path) : null;
}

export class ActorSnapshotStore {
  constructor(private readonly projectRoot: string, private readonly health: ApplicationPersistenceHealth, private readonly changes: ReadModelChanges, readonly namespace: ProjectNamespaceReader) {}

  restabilize(): void {
    for (const directory of actorSnapshotDirectories(this.projectRoot, this.namespace)) {
      const targets = readdirSync(directory).flatMap((name) => {
        if (name.endsWith('.json')) return [name];
        const target = durableReplacementTemporaryTargetBasename(name);
        return target?.endsWith('.json') ? [target] : [];
      });
      cleanupDurableReplacementTemporaries(directory, [...new Set(targets)]);
    }
    for (const path of actorSnapshotFilePaths(this.projectRoot, this.namespace)) readSnapshotFile(path);
  }

  readAll(): ActorSnapshotRecord[] { return readActiveActorSnapshots(this.projectRoot, this.namespace); }
  read(actorId: string): ActorSnapshotRecord | null { return readActiveActorSnapshot(this.projectRoot, actorId, this.namespace); }

  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord {
    assertSnapshotKind(snapshot);
    const saved = this.saveSnapshot(snapshot);
    this.publish(snapshot.actor_kind, snapshot.actor_id);
    return saved;
  }

  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord {
    if (actorKindFromId(actorId) !== 'card') throw new Error(`Cannot append card notification to non-card actor '${actorId}'.`);
    assertActiveActorCard(actorId, this.namespace);
    const path = actorSnapshotPath(this.projectRoot, actorId);
    this.health.assertMutationHealthy();
    const existing = existsSync(path) ? readSnapshotFile(path) : null;
    if (existing) assertSnapshotKind(existing);
    const context = existing?.context ?? { projectRoot: this.projectRoot, cardId: parseCardActorId(actorId) };
    const notifications = Array.isArray(context.notifications) ? context.notifications : [];
    const saved: ActorSnapshotRecord = {
      actor_id: actorId,
      actor_kind: 'card',
      state_value: existing?.state_value ?? null,
      context: { ...context, notifications: [...notifications, notification] },
      updated_at: new Date().toISOString(),
    };
    try { writeSnapshotFile(path, saved); }
    catch (error) { this.health.reportUncertainFailure({ target: path, operation: 'append actor notification', error }); }
    this.changes.runtimeChanged();
    return saved;
  }

  remove(actorId: string): boolean {
    const kind = actorKindFromId(actorId);
    this.health.assertMutationHealthy();
    assertActiveActorCard(actorId, this.namespace);
    const path = actorSnapshotPath(this.projectRoot, actorId);
    if (!existsSync(path)) return false;
    try { unlinkSync(path); }
    catch (error) { this.health.reportUncertainFailure({ target: path, operation: 'remove actor snapshot', error }); }
    const removed = true;
    if (removed) this.publish(kind, actorId);
    return removed;
  }

  private saveSnapshot(snapshot: ActorSnapshotRecord): ActorSnapshotRecord {
    this.health.assertMutationHealthy();
    assertActiveActorCard(snapshot.actor_id, this.namespace);
    const path = actorSnapshotPath(this.projectRoot, snapshot.actor_id);
    try { writeSnapshotFile(path, snapshot); }
    catch (error) { this.health.reportUncertainFailure({ target: path, operation: 'save actor snapshot', error }); }
    return snapshot;
  }

  private publish(kind: ActorKind, actorId: string): void {
    this.changes.runtimeChanged();
    if (kind !== 'llm') return;
    this.changes.agentsChanged();
    this.changes.conversationChanged(actorId);
  }
}

function readSnapshotFile(path: string): ActorSnapshotRecord {
  const json = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; data?: unknown };
  if (json.version !== ACTOR_SNAPSHOT_SCHEMA_VERSION) throw new Error(`Actor snapshot '${path}' has unsupported schema version.`);
  return actorSnapshotSchema.parse(json.data);
}

function writeSnapshotFile(path: string, snapshot: ActorSnapshotRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  durablyReplaceFile(path, Buffer.from(JSON.stringify({ version: ACTOR_SNAPSHOT_SCHEMA_VERSION, data: actorSnapshotSchema.parse(snapshot) }, null, 2) + '\n'));
}

function actorSnapshotFilePaths(projectRoot: string, namespace: ProjectNamespaceReader): string[] {
  const paths: string[] = [];
  collectSnapshotFiles(analystActorSnapshotsRoot(projectRoot), paths);

  for (const cardId of namespace.activeCardIds()) for (const kind of ['card', 'llm', 'processor'] as const) collectSnapshotFiles(cardActorSnapshotsRoot(projectRoot, cardId, kind), paths);
  return paths;
}

function actorSnapshotDirectories(projectRoot: string, namespace: ProjectNamespaceReader): string[] {
  const directories: string[] = [];
  const analyst = analystActorSnapshotsRoot(projectRoot);
  if (existsSync(analyst)) directories.push(analyst);
  for (const cardId of namespace.activeCardIds()) {
    for (const kind of ['card', 'llm', 'processor'] as const) {
      const directory = cardActorSnapshotsRoot(projectRoot, cardId, kind);
      if (existsSync(directory)) directories.push(directory);
    }
  }
  return directories;
}

function assertActiveActorCard(actorId: string, namespace: ProjectNamespaceReader): void {
  const kind = actorKindFromId(actorId);
  const cardId = kind === 'card' ? parseCardActorId(actorId) : kind === 'processor' ? parseProcessorActorId(actorId) : parseLlmActorId(actorId).cardId;
  if (cardId !== null && cardId !== undefined && !namespace.isActiveCardId(cardId)) throw new Error(`Card '${cardId}' not found.`);
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
