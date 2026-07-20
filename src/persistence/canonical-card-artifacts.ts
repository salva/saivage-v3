import { z } from 'zod';
import { cardHistoryEntrySchema, persistedCardRecordSchema, validatePersistedCardLifecycle, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { cardIdSchema } from '../schemas/card-id.js';
import { validateTransition } from '../cards/lifecycle.js';

export const cardVersionArtifactSchema = z.object({
  kind: z.literal('card-version'), format_version: z.literal(2), card_id: cardIdSchema,
  version: z.number().int().safe().positive(), committed_at: z.string().datetime(),
  card: persistedCardRecordSchema, history: cardHistoryEntrySchema.nullable(),
}).strict();
export const cardTombstoneSchema = z.object({
  kind: z.literal('card-tombstone'), format_version: z.literal(2), card_id: cardIdSchema,
  deleted_at: z.string().datetime(), final_card: persistedCardRecordSchema, deletion_history: cardHistoryEntrySchema,
}).strict();
export const cardStreamRowSchema = z.discriminatedUnion('kind', [cardVersionArtifactSchema, cardTombstoneSchema]);
export type CardVersionArtifact = z.infer<typeof cardVersionArtifactSchema>;
export type CardTombstone = z.infer<typeof cardTombstoneSchema>;
export type CardStreamRow = z.infer<typeof cardStreamRowSchema>;

function sameValues(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function assertOnlyCardFieldsChanged(path: string, prior: CardRecord, next: CardRecord, allowed: ReadonlySet<string>, transition: string): void {
  const keys = new Set([...Object.keys(prior), ...Object.keys(next)]);
  for (const key of keys) {
    if (!allowed.has(key) && !sameValues((next as unknown as Record<string, unknown>)[key], (prior as unknown as Record<string, unknown>)[key])) {
      throw new Error(`Card stream '${path}' ${transition} row mutates '${key}'.`);
    }
  }
}

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

export function validateCardStream(rows: readonly CardStreamRow[], path: string, cardId: string): { artifacts: CardVersionArtifact[]; tombstone: CardTombstone | null; current: CardVersionArtifact } {
  if (rows.length === 0) throw new Error(`Card stream '${path}' is empty.`);
  const artifacts: CardVersionArtifact[] = [];
  let tombstone: CardTombstone | null = null;
  for (const [index, raw] of rows.entries()) {
    if (raw.kind === 'card-tombstone') {
      if (cardId === 'project' || index !== rows.length - 1 || artifacts.length === 0) throw new Error(`Card stream '${path}' has an invalid tombstone position.`);
      const prior = artifacts.at(-1)!.card;
      if (raw.card_id !== cardId || JSON.stringify(raw.final_card) !== JSON.stringify(prior) || raw.deletion_history.kind !== 'delete' || JSON.stringify(raw.deletion_history.snapshot) !== JSON.stringify(prior)
        || raw.deletion_history.card_id !== raw.card_id || raw.deletion_history.changed_at !== raw.deleted_at || raw.deletion_history.version_seq !== raw.final_card.version_seq) throw new Error(`Card stream '${path}' has an invalid tombstone.`);
      tombstone = raw;
      continue;
    }
    const row = parseCardVersionArtifact(raw, path, { cardId, version: artifacts.length + 1 });
    if (tombstone) throw new Error(`Card stream '${path}' has a row after its tombstone.`);
    const prior = artifacts.at(-1)?.card;
    if (!prior) {
      if (row.card.children.length !== 0) throw new Error(`Initial card row at '${path}' must have no children.`);
    } else {
      if (!sameValues(row.history!.snapshot, prior)) throw new Error(`Card stream '${path}' history does not snapshot the prior card.`);
      const priorChildren = prior.children;
      const nextChildren = row.card.children;
      const childLink = row.history!.kind === 'child_link';
      const validLink = childLink && nextChildren.length === priorChildren.length + 1 && priorChildren.every((id, i) => nextChildren[i] === id);
      const reorder = row.history!.kind === 'mutate' && sameValues(row.history!.changed_fields, ['children']);
      const sameChildren = sameValues(nextChildren, priorChildren);
      const validReorder = reorder
        && !sameChildren
        && nextChildren.length === priorChildren.length
        && new Set(nextChildren).size === nextChildren.length
        && priorChildren.every((id) => nextChildren.includes(id));
      if (childLink ? !validLink : reorder ? !validReorder : !sameChildren) throw new Error(`Card stream '${path}' has an invalid children transition.`);
      for (const field of ['id', 'type', 'created_at', 'created_by'] as const) if (row.card[field] !== prior[field]) throw new Error(`Card stream '${path}' mutates immutable field '${field}'.`);
      if (row.card.lifecycle.status !== prior.lifecycle.status) {
        const narrowRecoveryTransition = row.history!.kind === 'status'
          && row.history!.changed_by_actor === 'runtime'
          && row.history!.changed_by_surface === 'runtime'
          && sameValues(row.history!.changed_fields, ['lifecycle'])
          && ((prior.lifecycle.status === 'running' && row.card.lifecycle.status === 'stopped' && row.history!.change_reason === 'recovery stopped lifecycle')
            || (prior.lifecycle.status === 'stopped' && row.card.lifecycle.status === 'running' && row.history!.change_reason === 'STOPPED activation'));
        if (narrowRecoveryTransition) assertOnlyCardFieldsChanged(path, prior, row.card, new Set(['lifecycle', 'version_seq', 'updated_at']), 'narrow recovery lifecycle');
        else validateTransition(prior.lifecycle.status, row.card.lifecycle.status);
      }
      if (childLink) {
        assertOnlyCardFieldsChanged(path, prior, row.card, new Set(['children', 'version_seq', 'updated_at']), 'child-link');
      } else if (reorder) {
        assertOnlyCardFieldsChanged(path, prior, row.card, new Set(['children', 'version_seq', 'updated_at']), 'children-reorder');
      }
    }
    artifacts.push(row);
  }
  return { artifacts, tombstone, current: artifacts.at(-1)! };
}
