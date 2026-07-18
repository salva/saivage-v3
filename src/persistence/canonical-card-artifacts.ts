import { z } from 'zod';
import { cardHistoryEntrySchema, persistedCardRecordSchema, validatePersistedCardLifecycle, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { cardIdSchema, cardSegmentSchema, childCardId, nextCardSegment } from '../schemas/card-id.js';
import { validateTransition } from '../cards/lifecycle.js';

export const cardVersionArtifactSchema = z.object({
  kind: z.literal('card-version'), format_version: z.literal(1), card_id: cardIdSchema,
  version: z.number().int().safe().positive(), committed_at: z.string().datetime(),
  card: persistedCardRecordSchema, history: cardHistoryEntrySchema.nullable(),
}).strict();
export const cardTombstoneSchema = z.object({
  kind: z.literal('card-tombstone'), format_version: z.literal(1), card_id: cardIdSchema,
  deleted_at: z.string().datetime(), final_card: persistedCardRecordSchema, deletion_history: cardHistoryEntrySchema,
}).strict();
export const cardChildReservationSchema = z.object({
  kind: z.literal('card-child-reservation'), format_version: z.literal(1), card_id: cardIdSchema,
  segment: cardSegmentSchema, child_id: cardIdSchema,
}).strict();
export const cardStreamRowSchema = z.discriminatedUnion('kind', [cardVersionArtifactSchema, cardChildReservationSchema, cardTombstoneSchema]);
export type CardVersionArtifact = z.infer<typeof cardVersionArtifactSchema>;
export type CardChildReservation = z.infer<typeof cardChildReservationSchema>;
export type CardTombstone = z.infer<typeof cardTombstoneSchema>;
export type CardStreamRow = z.infer<typeof cardStreamRowSchema>;

export function parseCardVersionArtifact(raw: unknown, path: string, expected?: { cardId: string; version: number }): CardVersionArtifact {
  const parsed = cardVersionArtifactSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Card version row at '${path}' is invalid: ${parsed.error.message}`);
  const row = parsed.data;
  validatePersistedCardLifecycle(row.card);
  if (row.card_id !== row.card.id || row.version !== row.card.version_seq) throw new Error(`Card version row at '${path}' has inconsistent identity.`);
  if (expected && (row.card_id !== expected.cardId || row.version !== expected.version)) throw new Error(`Card version row at '${path}' does not match its stream.`);
  if ((row.version === 1) !== (row.history === null)) throw new Error(`Card version row at '${path}' has invalid history presence.`);
  if (row.history && (row.history.card_id !== row.card_id || row.history.version_seq !== row.version - 1)) throw new Error(`Card version row at '${path}' has inconsistent history.`);
  return row;
}

export function validateCardStream(rows: readonly CardStreamRow[], path: string, cardId: string): { rows: CardStreamRow[]; artifacts: CardVersionArtifact[]; reservations: CardChildReservation[]; tombstone: CardTombstone | null; current: CardVersionArtifact } {
  if (rows.length === 0) throw new Error(`Card stream '${path}' is empty.`);
  const artifacts: CardVersionArtifact[] = [];
  const reservations: CardChildReservation[] = [];
  let tombstone: CardTombstone | null = null;
  for (const [index, raw] of rows.entries()) {
    if (raw.kind === 'card-tombstone') {
      if (cardId === 'project' || index !== rows.length - 1 || artifacts.length === 0) throw new Error(`Card stream '${path}' has an invalid tombstone position.`);
      const prior = artifacts.at(-1)!.card;
      if (raw.card_id !== cardId || JSON.stringify(raw.final_card) !== JSON.stringify(prior) || raw.deletion_history.kind !== 'delete' || JSON.stringify(raw.deletion_history.snapshot) !== JSON.stringify(prior)) throw new Error(`Card stream '${path}' has an invalid tombstone.`);
      tombstone = raw;
      continue;
    }
    if (raw.kind === 'card-child-reservation') {
      if (tombstone || artifacts.length === 0 || raw.card_id !== cardId) throw new Error(`Card stream '${path}' has an invalid child reservation position or owner.`);
      const expectedSegment = nextCardSegment(reservations.at(-1)?.segment);
      if (raw.segment !== expectedSegment || raw.child_id !== childCardId(cardId, raw.segment)) throw new Error(`Card stream '${path}' has a non-sequential child reservation.`);
      reservations.push(raw);
      continue;
    }
    const row = parseCardVersionArtifact(raw, path, { cardId, version: artifacts.length + 1 });
    if (tombstone) throw new Error(`Card stream '${path}' has a row after its tombstone.`);
    const prior = artifacts.at(-1)?.card;
    if (!prior) {
      if (row.card.children.length !== 0) throw new Error(`Initial card row at '${path}' must have no children.`);
    } else {
      if (JSON.stringify(row.history!.snapshot) !== JSON.stringify(prior)) throw new Error(`Card stream '${path}' history does not snapshot the prior card.`);
      const priorChildren = prior.children;
      const nextChildren = row.card.children;
      const childLink = row.history!.kind === 'child_link';
      const validLink = childLink && nextChildren.length === priorChildren.length + 1 && priorChildren.every((id, i) => nextChildren[i] === id);
      if (childLink ? !validLink : JSON.stringify(nextChildren) !== JSON.stringify(priorChildren)) throw new Error(`Card stream '${path}' has an invalid children transition.`);
      for (const field of ['id', 'type', 'parent', 'depth', 'created_at', 'created_by'] as const) if (row.card[field] !== prior[field]) throw new Error(`Card stream '${path}' mutates immutable field '${field}'.`);
      if (row.card.status !== prior.status) validateTransition(prior.status, row.card.status);
      if (childLink) {
        const linkedChild = nextChildren.at(-1)!;
        const preceding = rows[index - 1];
        if (preceding?.kind !== 'card-child-reservation' || preceding.child_id !== linkedChild) throw new Error(`Card stream '${path}' links child '${linkedChild}' without an immediately preceding matching reservation.`);
        const mutable = new Set(['children', 'version_seq', 'updated_at']);
        for (const key of Object.keys(prior) as Array<keyof CardRecord>) if (!mutable.has(key) && JSON.stringify(row.card[key]) !== JSON.stringify(prior[key])) throw new Error(`Card stream '${path}' child-link row mutates '${String(key)}'.`);
      }
    }
    artifacts.push(row);
  }
  return { rows: [...rows], artifacts, reservations, tombstone, current: artifacts.at(-1)! };
}
