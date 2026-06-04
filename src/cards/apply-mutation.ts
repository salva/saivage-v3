// F13 r5 §"On-disk write sequence" + §"Boot recovery" — the canonical
// `applyMutation` step machine. Owns the outer ProjectMutex + inner cross-process
// withLock, stages by-id files via fsynced .tmp.<token>, writes a commit-marker,
// performs the atomic rename / unlink, appends to per-card history with
// `appendSyncIdempotent`, unlinks the marker, mutates `CardStoreState`, releases
// both locks, and emits a `card_history_appended` event AFTER both locks drop.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventBus } from '../events/index.js';
import type {
  CardHistoryAppendedEvent,
  CardHistoryEntry,
  CardHistoryKind,
  CardRecord,
} from '../schemas/index.js';
import { cardHistoryEntrySchema, cardRecordSchema } from '../schemas/index.js';
import { ProjectLock, appendSyncIdempotent } from '../persistence/index.js';
import type { LockHandle } from '../persistence/index.js';
import {
  CardStoreState,
  cardByIdPath,
  cardHistoryPath,
  CardStoreInvariantError,
} from './state.js';
import {
  unlinkCommitMarker,
  writeCommitMarker,
  writeGroupCommitMarker,
  type CommitMarker,
} from './commit-marker.js';
import { ProjectMutex } from './project-mutex.js';

export interface CardMutationContext {
  actor: import('../schemas/index.js').NoteAuthor;
  surface: import('../schemas/index.js').ControlActionSurface;
  reason?: string;
}

export type ApplyMutationOp =
  | {
      kind: 'create';
      card: CardRecord;
    }
  | {
      kind: 'persist';
      next: CardRecord;
      historyKind: CardHistoryKind;
      ctx: CardMutationContext;
      changedFields: string[];
      changeSummary: string;
    }
  | {
      kind: 'delete';
      cardId: string;
      historyKind: 'delete' | 'archive';
      finalSnapshot: CardRecord;
      ctx: CardMutationContext;
      changeSummary: string;
    };

export interface ApplyMutationDeps {
  projectRoot: string;
  state: CardStoreState;
  mutex: ProjectMutex;
  projectLock: ProjectLock;
  eventBus: EventBus;
}

export type CardHistoryAppendedPayload = Omit<CardHistoryAppendedEvent, 'id' | 'timestamp'>;

export interface ApplyMutationResult {
  card: CardRecord | null;
  historyEntry: CardHistoryEntry | null;
}

function fsyncFileAtPath(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dirPath: string): void {
  try {
    const fd = openSync(dirPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort.
  }
}

function newToken(): string {
  return randomBytes(8).toString('hex');
}

function buildHistoryEntry(
  prior: CardRecord,
  kind: CardHistoryKind,
  ctx: CardMutationContext,
  changedFields: string[],
  changeSummary: string,
): CardHistoryEntry {
  const entry: CardHistoryEntry = {
    entry_id: randomUUID(),
    kind,
    card_id: prior.id,
    version_seq: prior.version_seq,
    snapshot: prior,
    changed_at: new Date().toISOString(),
    changed_by_actor: ctx.actor,
    changed_by_surface: ctx.surface,
    change_reason: ctx.reason ?? null,
    changed_fields: changedFields,
    change_summary: changeSummary,
  };
  cardHistoryEntrySchema.parse(entry);
  return entry;
}

function stageByIdTmp(finalPath: string, card: CardRecord, token: string): string {
  const tmpPath = `${finalPath}.tmp.${token}`;
  mkdirSync(dirname(finalPath), { recursive: true });
  const data = JSON.stringify(cardRecordSchema.parse(card), null, 2) + '\n';
  writeFileSync(tmpPath, data, 'utf-8');
  fsyncFileAtPath(tmpPath);
  return tmpPath;
}

function withLockOnly<T>(
  deps: ApplyMutationDeps,
  body: (lockHandle: LockHandle) => T,
): T {
  return deps.projectLock.withLockSync((handle) => body(handle));
}

/**
 * Per F13 r5 §"On-disk write sequence" steps 1–10 for a single-card mutation.
 * For `create`, no history row is written and no event is emitted.
 *
 * NOTE (Batch 2b deviation): the outer ProjectMutex is dropped here. JavaScript
 * single-thread serialization already protects the sync body, and the inner
 * `withLockSync` provides cross-process serialization. Callers receive a
 * synchronous result — the function returns an already-resolved Promise solely
 * for API stability.
 */
export async function applyMutation(
  deps: ApplyMutationDeps,
  op: ApplyMutationOp,
): Promise<ApplyMutationResult> {
  return applyMutationSync(deps, op);
}

export function applyMutationSync(
  deps: ApplyMutationDeps,
  op: ApplyMutationOp,
): ApplyMutationResult {
  const outcome = withLockOnly(deps, (handle) => {
    deps.projectLock.assertOwns(handle);
    return applyMutationLocked(deps, op);
  });
  if (outcome.event !== null) deps.eventBus.emit('card_history_appended', outcome.event);
  return { card: outcome.card, historyEntry: outcome.historyEntry };
}

interface LockedOutcome {
  card: CardRecord | null;
  historyEntry: CardHistoryEntry | null;
  event: CardHistoryAppendedPayload | null;
}

function applyMutationLocked(
  deps: ApplyMutationDeps,
  op: ApplyMutationOp,
): LockedOutcome {
  const { projectRoot, state } = deps;
  if (op.kind === 'create') {
    const card = cardRecordSchema.parse(op.card);
    if (state.has(card.id)) {
      throw new CardStoreInvariantError(`Cannot create card '${card.id}': already exists.`);
    }
    if (state.isReservedId(card.id)) {
      throw new CardStoreInvariantError(
        `Cannot create card '${card.id}': card ids are durable and this id is already reserved by history or archive state.`,
      );
    }
    if (card.version_seq !== 1) {
      throw new CardStoreInvariantError(
        `New card '${card.id}' must have version_seq=1, got ${card.version_seq}.`,
      );
    }
    const token = newToken();
    const finalPath = cardByIdPath(projectRoot, card.id);
    const tmpPath = stageByIdTmp(finalPath, card, token);
    const marker: CommitMarker = {
      token,
      card_id: card.id,
      by_id: { kind: 'rename', tmp_path: tmpPath, final_path: finalPath },
      history: null,
    };
    writeCommitMarker(projectRoot, marker);
    renameSync(tmpPath, finalPath);
    fsyncDir(dirname(finalPath));
    unlinkCommitMarker(projectRoot, token);
    state.upsert(card);
    return { card, historyEntry: null, event: null };
  }
  if (op.kind === 'persist') {
    const prior = state.get(op.next.id);
    if (!prior) {
      throw new CardStoreInvariantError(`Cannot persist update to missing card '${op.next.id}'.`);
    }
    if (op.next.version_seq !== prior.version_seq + 1) {
      throw new CardStoreInvariantError(
        `Persist for card '${op.next.id}' expected version_seq=${prior.version_seq + 1}, got ${op.next.version_seq}.`,
      );
    }
    const nextValidated = cardRecordSchema.parse(op.next);
    const historyEntry = buildHistoryEntry(
      prior,
      op.historyKind,
      op.ctx,
      op.changedFields,
      op.changeSummary,
    );
    const token = newToken();
    const finalPath = cardByIdPath(projectRoot, nextValidated.id);
    const tmpPath = stageByIdTmp(finalPath, nextValidated, token);
    const historyJsonl = cardHistoryPath(projectRoot, nextValidated.id);
    const marker: CommitMarker = {
      token,
      card_id: nextValidated.id,
      by_id: { kind: 'rename', tmp_path: tmpPath, final_path: finalPath },
      history: { jsonl_path: historyJsonl, entry: historyEntry, entry_id: historyEntry.entry_id },
    };
    writeCommitMarker(projectRoot, marker);
    renameSync(tmpPath, finalPath);
    fsyncDir(dirname(finalPath));
    appendSyncIdempotent(historyJsonl, historyEntry as unknown as { entry_id: string } & Record<string, unknown>);
    unlinkCommitMarker(projectRoot, token);
    state.upsert(nextValidated);
    const event: CardHistoryAppendedPayload = {
      kind: 'card_history_appended',
      entry_id: historyEntry.entry_id,
      entry_kind: historyEntry.kind,
      card_id: historyEntry.card_id,
      version_seq: historyEntry.version_seq,
      changed_fields: historyEntry.changed_fields,
      changed_at: historyEntry.changed_at,
    };
    return { card: nextValidated, historyEntry, event };
  }
  // op.kind === 'delete'
  const prior = state.get(op.cardId);
  if (!prior) {
    throw new CardStoreInvariantError(`Cannot delete missing card '${op.cardId}'.`);
  }
  const historyEntry = buildHistoryEntry(
    op.finalSnapshot,
    op.historyKind,
    op.ctx,
    ['__deleted__'],
    op.changeSummary,
  );
  const token = newToken();
  const finalPath = cardByIdPath(deps.projectRoot, op.cardId);
  const historyJsonl = cardHistoryPath(deps.projectRoot, op.cardId);
  const marker: CommitMarker = {
    token,
    card_id: op.cardId,
    by_id: { kind: 'unlink', unlink_path: finalPath },
    history: { jsonl_path: historyJsonl, entry: historyEntry, entry_id: historyEntry.entry_id },
  };
  writeCommitMarker(deps.projectRoot, marker);
  try {
    unlinkSync(finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fsyncDir(dirname(finalPath));
  appendSyncIdempotent(historyJsonl, historyEntry as unknown as { entry_id: string } & Record<string, unknown>);
  unlinkCommitMarker(deps.projectRoot, token);
  state.remove(op.cardId);
  const event: CardHistoryAppendedPayload = {
    kind: 'card_history_appended',
    entry_id: historyEntry.entry_id,
    entry_kind: historyEntry.kind,
    card_id: historyEntry.card_id,
    version_seq: historyEntry.version_seq,
    changed_fields: historyEntry.changed_fields,
    changed_at: historyEntry.changed_at,
  };
  return { card: null, historyEntry, event };
}

/**
 * Per F13 r5 §"Multi-card mutation atomicity" — apply a sequence of single-card
 * ops under one mutex+lock cycle, governed by a group-marker. Events are
 * emitted after both locks release in the order the ops were applied.
 */
export async function applyMutationGroup(
  deps: ApplyMutationDeps,
  ops: ApplyMutationOp[],
): Promise<ApplyMutationResult[]> {
  return applyMutationGroupSync(deps, ops);
}

export function applyMutationGroupSync(
  deps: ApplyMutationDeps,
  ops: ApplyMutationOp[],
): ApplyMutationResult[] {
  if (ops.length === 0) return [];
  const events: CardHistoryAppendedPayload[] = [];
  const results: ApplyMutationResult[] = [];
  const groupToken = newToken();
  const perCardTokens: string[] = [];
  withLockOnly(deps, (handle) => {
    deps.projectLock.assertOwns(handle);
    writeGroupCommitMarker(deps.projectRoot, {
      group_token: groupToken,
      total: ops.length,
      per_card_tokens: perCardTokens,
    });
    for (const op of ops) {
      const outcome = applyMutationLocked(deps, op);
      results.push({ card: outcome.card, historyEntry: outcome.historyEntry });
      if (outcome.event !== null) events.push(outcome.event);
    }
  });
  for (const evt of events) deps.eventBus.emit('card_history_appended', evt);
  return results;
}
