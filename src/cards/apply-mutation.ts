// F13 r5 §"On-disk write sequence" + §"Boot recovery" — the canonical sync
// card mutation step machine. Owns the cross-process withLock, writes versioned
// card.json records, updates `CardStoreState`, releases the lock, and emits a
// `card_history_appended` event AFTER the lock drops.

import {
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventBus } from '../events/index.js';
import type {
  CardHistoryAppendedEvent,
  CardHistoryEntry,
  CardHistoryKind,
  CardRecord,
} from '../schemas/index.js';
import { cardHistoryEntrySchema } from '../schemas/index.js';
import { ProjectLock } from '../persistence/index.js';
import type { LockHandle } from '../persistence/index.js';
import { fsyncDir } from '../persistence/durable-write.js';
import { CardStoreState } from './state.js';
import { CardStoreInvariantError } from './errors.js';
import { cardRecordNamespaceDir, writeBriefRecordVersion, writeCardRecordVersion } from '../persistence/card-loader.js';
import type { CardMutationContext } from './lifecycle.js';

export type ApplyMutationOp =
  | {
      kind: 'create';
      card: CardRecord;
      briefContent: string;
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
  projectLock: ProjectLock;
  eventBus: EventBus;
}

export type CardHistoryAppendedPayload = Omit<CardHistoryAppendedEvent, 'id' | 'timestamp'>;

export interface ApplyMutationResult {
  card: CardRecord | null;
  historyEntry: CardHistoryEntry | null;
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
 * JavaScript single-thread serialization protects the sync body, and
 * `withLockSync` provides cross-process serialization.
 */
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

export interface ApplyMutationLockedOutcome {
  card: CardRecord | null;
  historyEntry: CardHistoryEntry | null;
  event: CardHistoryAppendedPayload | null;
}

export function applyMutationWithOwnedLockSync(
  deps: ApplyMutationDeps,
  lockHandle: LockHandle,
  op: ApplyMutationOp,
): ApplyMutationLockedOutcome {
  deps.projectLock.assertOwns(lockHandle);
  return applyMutationLocked(deps, op);
}

function applyMutationLocked(
  deps: ApplyMutationDeps,
  op: ApplyMutationOp,
): ApplyMutationLockedOutcome {
  const { projectRoot, state } = deps;
  if (op.kind === 'create') {
    const card = op.card;
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
    writeCardRecordVersion(projectRoot, card);
    writeBriefRecordVersion(projectRoot, card, op.briefContent, card.created_by === 'planner' ? 'planner' : 'analyst');
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
    const nextValidated = op.next;
    const historyEntry = buildHistoryEntry(
      prior,
      op.historyKind,
      op.ctx,
      op.changedFields,
      op.changeSummary,
    );
    writeCardRecordVersion(projectRoot, nextValidated, historyEntry);
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
  const liveDir = cardRecordNamespaceDir(deps.projectRoot, op.cardId);
  const archiveDir = join(deps.projectRoot, '.saivage', 'archive', 'cards', op.cardId);
  mkdirSync(dirname(archiveDir), { recursive: true });
  rmSync(archiveDir, { recursive: true, force: true });
  renameSync(liveDir, archiveDir);
  fsyncDir(dirname(archiveDir));
  fsyncDir(dirname(liveDir));
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

/** Apply a sequence of single-card ops under one lock cycle. */
export function applyMutationGroupSync(
  deps: ApplyMutationDeps,
  ops: ApplyMutationOp[],
): ApplyMutationResult[] {
  if (ops.length === 0) return [];
  const events: CardHistoryAppendedPayload[] = [];
  const results: ApplyMutationResult[] = [];
  withLockOnly(deps, (handle) => {
    deps.projectLock.assertOwns(handle);
    for (const op of ops) {
      const outcome = applyMutationLocked(deps, op);
      results.push({ card: outcome.card, historyEntry: outcome.historyEntry });
      if (outcome.event !== null) events.push(outcome.event);
    }
  });
  for (const evt of events) deps.eventBus.emit('card_history_appended', evt);
  return results;
}
