import { z } from 'zod';
import { cardIdSchema } from './card-id.js';
import { recordNameSchema } from './record-name.js';
import { uuidV4Schema } from './uuid.js';
import { canonicalJson } from './canonical-json.js';

const positive = z.number().int().safe().positive();
const nonnegative = z.number().int().safe().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const acceptedSelection = z
  .object({
    kind: z.literal('accepted'),
    entry_id: uuidV4Schema,
    version: positive,
    locator: z.string().min(1),
    content_sha256: hash,
  })
  .strict();
export const recordSelectionObservationSchema = z
  .object({
    card_id: cardIdSchema,
    record_name: recordNameSchema,
    view: z.enum(['accepted', 'effective']),
    selection_kind: z.enum(['current', 'historical']),
    head: z.object({ head_id: uuidV4Schema, revision: positive }).strict().nullable(),
    selection: z.discriminatedUnion('kind', [
      acceptedSelection,
      z
        .object({
          kind: z.literal('draft'),
          content_sha256: hash,
          accepted_backing: acceptedSelection.nullable(),
        })
        .strict(),
      z.object({ kind: z.literal('absent') }).strict(),
      z.object({ kind: z.literal('empty') }).strict(),
    ]),
    exposure: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('metadata') }).strict(),
      z.object({ kind: z.literal('reference_only') }).strict(),
      z.object({ kind: z.literal('full_body') }).strict(),
      z.object({ kind: z.literal('excerpt') }).strict(),
      z
        .object({
          kind: z.literal('slice'),
          offset_bytes: nonnegative,
          utf8_bytes: nonnegative,
          total_bytes: nonnegative,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (value.view === 'accepted' && value.selection.kind === 'draft')
      issue('Accepted view cannot select a draft.');
    if (
      value.selection_kind === 'historical' &&
      (value.head !== null || value.selection.kind !== 'accepted')
    )
      issue(
        'Historical observation requires an immutable accepted selection without a current head.',
      );
    if (
      value.selection_kind === 'current' &&
      value.head === null &&
      value.selection.kind !== 'absent'
    )
      issue('Present current observation requires exact head identity.');
    if (value.selection.kind === 'absent' && value.head !== null && value.view === 'effective')
      issue('An absent effective record has no head.');
    if (
      (value.selection.kind === 'absent' || value.selection.kind === 'empty') &&
      (value.exposure.kind === 'slice' ||
        value.exposure.kind === 'full_body' ||
        value.exposure.kind === 'excerpt')
    )
      issue('No selected body exists for body exposure.');
    if (
      value.exposure.kind === 'slice' &&
      value.exposure.offset_bytes + value.exposure.utf8_bytes > value.exposure.total_bytes
    )
      issue('Record slice exceeds its selected body.');
    const accepted =
      value.selection.kind === 'accepted'
        ? value.selection
        : value.selection.kind === 'draft'
          ? value.selection.accepted_backing
          : null;
    if (accepted && value.head && accepted.version > value.head.revision)
      issue('Accepted selection exceeds current head revision.');
    if (
      accepted &&
      accepted.locator !==
        `record:///${encodeURIComponent(value.record_name)}?card=${encodeURIComponent(value.card_id)}&v=${accepted.version}`
    )
      issue('Accepted locator disagrees with observed identity.');
  });

const recordObservationSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['read', 'mutation']),
      input_id: uuidV4Schema,
      tool_call_id: z.string().min(1),
      tool_name: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal('preparation'), input_id: uuidV4Schema, node_id: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal('prompt'),
      input_id: uuidV4Schema,
      node_id: z.string().min(1),
      reference: z.string().min(1),
    })
    .strict(),
]);
export const recordObservationSchema = z
  .object({
    observed: recordSelectionObservationSchema,
    source: recordObservationSourceSchema,
  })
  .strict();
export const latestRecordObservationSchema = z
  .object({
    source: z
      .object({
        segmentVersion: positive,
        rowIndex: nonnegative,
        messageId: z.string().min(1),
        timestamp: z.string().datetime(),
      })
      .strict(),
    observation: recordObservationSchema,
  })
  .strict()
  .refine(
    (value) => value.observation.observed.selection_kind === 'current',
    'Latest record knowledge must come from a current observation.',
  );
export type RecordSelectionObservation = z.infer<typeof recordSelectionObservationSchema>;
export type RecordObservation = z.infer<typeof recordObservationSchema>;
export type LatestRecordObservation = z.infer<typeof latestRecordObservationSchema>;

// Public/model descriptor identity is not an internal byte commitment.
const publicAcceptedSelection = acceptedSelection.omit({ content_sha256: true });
const publicRecordSelectionObservationSchema = recordSelectionObservationSchema.innerType().extend({
  record_name: z.string().min(1),
  selection: z.discriminatedUnion('kind', [
    publicAcceptedSelection,
    z
      .object({ kind: z.literal('draft'), accepted_backing: publicAcceptedSelection.nullable() })
      .strict(),
    z.object({ kind: z.literal('absent') }).strict(),
    z.object({ kind: z.literal('empty') }).strict(),
  ]),
});
export const publicRecordObservationSchema = recordObservationSchema.extend({
  observed: publicRecordSelectionObservationSchema,
});
export const publicLatestRecordObservationSchema = latestRecordObservationSchema
  .innerType()
  .extend({ observation: publicRecordObservationSchema });
export function publicRecordSelection(
  value: RecordSelectionObservation,
): z.infer<typeof publicRecordSelectionObservationSchema> {
  const accepted = (selection: z.infer<typeof acceptedSelection>) => ({
    kind: selection.kind,
    entry_id: selection.entry_id,
    version: selection.version,
    locator: selection.locator,
  });
  return {
    card_id: value.card_id,
    record_name: value.record_name,
    view: value.view,
    selection_kind: value.selection_kind,
    head: value.head,
    selection:
      value.selection.kind === 'accepted'
        ? accepted(value.selection)
        : value.selection.kind === 'draft'
          ? {
              kind: 'draft',
              accepted_backing: value.selection.accepted_backing
                ? accepted(value.selection.accepted_backing)
                : null,
            }
          : { kind: value.selection.kind },
    exposure: value.exposure,
  };
}

export function recordObservationKey(
  value: Pick<RecordSelectionObservation, 'card_id' | 'record_name' | 'view'>,
): string {
  return JSON.stringify([value.card_id, value.record_name, value.view]);
}
/** Selection equality is not head freshness, exposure, or equal body bytes across acceptances. */
export function sameRecordSelection(
  a: RecordSelectionObservation,
  b: RecordSelectionObservation,
): boolean {
  return (
    recordObservationKey(a) === recordObservationKey(b) &&
    canonicalJson(a.selection) === canonicalJson(b.selection)
  );
}
