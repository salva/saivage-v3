import {
  recordSelectionObservationSchema,
  type RecordSelectionObservation,
} from '../schemas/index.js';
import type { CurrentRecordProjection, AcceptedRecordProjection } from './authored-record-files.js';

/** Pure projection of the exact owning read/publication. Performs no I/O. */
export function observeRecordProjection(
  args: {
    cardId: string;
    recordName: string;
    view: 'accepted' | 'effective';
    exposure: RecordSelectionObservation['exposure'];
  } & (
    | { projection: CurrentRecordProjection | null; selectionKind: 'current' }
    | { projection: AcceptedRecordProjection; selectionKind: 'historical' }
  ),
): RecordSelectionObservation {
  const { projection: p } = args;
  const accepted = p?.accepted
    ? {
        kind: 'accepted' as const,
        entry_id: p.accepted.source_entry_id,
        version: p.accepted.source_version,
        locator: p.acceptedVersionUrl!,
        content_sha256: p.accepted.content_sha256,
      }
    : null;
  const selection =
    args.view === 'effective' && p?.draft
      ? {
          kind: 'draft' as const,
          version: p.draft.version,
          target_version: p.draft.target_version,
          content_sha256: p.draft.content_sha256,
          accepted_backing: accepted,
        }
      : args.view === 'effective' && p?.baseline
        ? {
            kind: 'baseline' as const,
            version: 0 as const,
            content_sha256: p.baseline.content_sha256,
          }
        : (accepted ?? {
            kind: p && args.view === 'effective' ? ('empty' as const) : ('absent' as const),
          });
  return recordSelectionObservationSchema.parse({
    card_id: args.cardId,
    record_name: args.recordName,
    view: args.view,
    selection_kind: args.selectionKind,
    head:
      args.selectionKind === 'current' && p ? { head_id: p.headId, revision: p.revision } : null,
    selection,
    exposure:
      (selection.kind === 'absent' || selection.kind === 'empty') &&
      (args.exposure.kind === 'slice' || args.exposure.kind === 'full_body')
        ? { kind: 'metadata' }
        : args.exposure,
  });
}
