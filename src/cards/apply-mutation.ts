// Applies card mutations through the composition-owned persistence authority.

import { randomUUID } from 'node:crypto';
import { EventBus } from '../events/index.js';
import type {
  CardHistoryAppendedEvent,
  CardHistoryEntry,
  CardHistoryKind,
  CardRecord,
} from '../schemas/index.js';
import { cardHistoryEntrySchema } from '../schemas/index.js';
import type { ProjectCardRecordWriter, ProjectMutationSession } from '../persistence/project-persistence-authority.js';
import { CardStoreState } from './state.js';
import { CardStoreInvariantError } from './errors.js';
import type { CardMutationContext } from './lifecycle.js';
import { reserveDeletedCardIds } from '../persistence/deleted-card-ids.js';

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
  writer: ProjectCardRecordWriter;
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

export function applyMutationSync(
  deps: ApplyMutationDeps,
  op: ApplyMutationOp,
): ApplyMutationResult {
  const outcome = deps.writer.request((session) => applyMutationLocked(deps, session, op));
  if (outcome.event !== null) deps.eventBus.emit('card_history_appended', outcome.event);
  return { card: outcome.card, historyEntry: outcome.historyEntry };
}

export interface ApplyMutationLockedOutcome {
  card: CardRecord | null;
  historyEntry: CardHistoryEntry | null;
  event: CardHistoryAppendedPayload | null;
}

function applyMutationLocked(
  deps: ApplyMutationDeps,
  writer: ProjectMutationSession,
  op: ApplyMutationOp,
): ApplyMutationLockedOutcome {
  const { state } = deps;
  if (op.kind === 'create') {
    const card = op.card;
    if (state.has(card.id)) {
      throw new CardStoreInvariantError(`Cannot create card '${card.id}': already exists.`);
    }
    if (state.isReservedId(card.id)) {
      throw new CardStoreInvariantError(
        `Cannot create card '${card.id}': card ids are durable and this id is already reserved by deleted-card state.`,
      );
    }
    if (card.version_seq !== 1) {
      throw new CardStoreInvariantError(
        `New card '${card.id}' must have version_seq=1, got ${card.version_seq}.`,
      );
    }
    writer.createCard(card, op.briefContent, card.created_by === 'planner' ? 'planner' : 'analyst');
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
    writer.writeCard(nextValidated, historyEntry);
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
  reserveDeletedCardIds(deps.projectRoot, [op.cardId]);
  writer.deleteCard(op.cardId);
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
  deps.writer.request((writer) => {
    for (const op of ops) {
      const outcome = applyMutationLocked(deps, writer, op);
      results.push({ card: outcome.card, historyEntry: outcome.historyEntry });
      if (outcome.event !== null) events.push(outcome.event);
    }
  });
  for (const evt of events) deps.eventBus.emit('card_history_appended', evt);
  return results;
}
