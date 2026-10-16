import {
  recordSelectionObservationSchema,
  type RecordSelectionObservation,
} from '../schemas/index.js';
import type { RecordProjection } from './authored-record-files.js';
import { isUnfilledRecordDraft } from './canonical-record-artifacts.js';

/** Pure projection of the exact owning read/publication. Performs no I/O. */
export function observeRecordProjection(args: {
  cardId: string;
  recordName: string;
  projection: RecordProjection | null;
  view: 'accepted' | 'effective';
  selectionKind: 'current' | 'historical';
  exposure: RecordSelectionObservation['exposure'];
}): RecordSelectionObservation {
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
          unfilled: isUnfilledRecordDraft(p.draft),
          content_sha256: p.draft.content_sha256,
          accepted_backing: accepted,
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
