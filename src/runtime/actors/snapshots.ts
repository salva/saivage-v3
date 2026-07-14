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

export function readActorSnapshots(projectRoot: string): ActorSnapshotRecord[] {
  const paths = actorSnapshotFilePaths(projectRoot);
  return paths
    .map((path) => {
      const snapshot = readSnapshotFile(path);
      assertSnapshotKind(snapshot);
      return snapshot;
    })
    .sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}

export function readActorSnapshot(projectRoot: string, actorId: string): ActorSnapshotRecord | null {
  const path = actorSnapshotPath(projectRoot, actorId);
  if (!existsSync(path)) return null;
  const snapshot = readSnapshotFile(path);
  assertSnapshotKind(snapshot);
  return snapshot;
}

export class ActorSnapshotStore {
  constructor(private readonly projectRoot: string, private readonly health: ApplicationPersistenceHealth, private readonly changes: ReadModelChanges) {}

  restabilize(): void {
    for (const directory of actorSnapshotDirectories(this.projectRoot)) {
      const targets = readdirSync(directory).flatMap((name) => {
        if (name.endsWith('.json')) return [name];
        const target = durableReplacementTemporaryTargetBasename(name);
        return target?.endsWith('.json') ? [target] : [];
      });
      cleanupDurableReplacementTemporaries(directory, [...new Set(targets)]);
    }
    for (const path of actorSnapshotFilePaths(this.projectRoot)) readSnapshotFile(path);
  }

  save(snapshot: ActorSnapshotRecord): ActorSnapshotRecord {
    assertSnapshotKind(snapshot);
    const saved = this.saveSnapshot(snapshot);
    this.publish(snapshot.actor_kind, snapshot.actor_id);
    return saved;
  }

  appendNotification(actorId: string, notification: CardNotification): ActorSnapshotRecord {
    if (actorKindFromId(actorId) !== 'card') throw new Error(`Cannot append card notification to non-card actor '${actorId}'.`);
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

function actorSnapshotDirectories(projectRoot: string): string[] {
  const directories: string[] = [];
  const analyst = analystActorSnapshotsRoot(projectRoot);
  if (existsSync(analyst)) directories.push(analyst);
  const cardsRoot = saivageCardsRoot(projectRoot);
  if (!existsSync(cardsRoot)) return directories;
  for (const cardEntry of readdirSync(cardsRoot, { withFileTypes: true })) {
    if (!cardEntry.isDirectory()) continue;
    for (const kind of ['card', 'llm', 'processor'] as const) {
      const directory = cardActorSnapshotsRoot(projectRoot, cardEntry.name, kind);
      if (existsSync(directory)) directories.push(directory);
    }
  }
  return directories;
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
