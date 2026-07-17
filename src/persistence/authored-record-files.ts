import { basename } from 'node:path';
import type { AgentRole } from '../schemas/index.js';
import { authoredRecordSlotValues, parseRecordVersionArtifact, recordVersionArtifactSchema, validateRecordStream, type AuthoredRecordSlot, type RecordVersionArtifact } from './canonical-record-artifacts.js';
import { readCard } from './card-files.js';
import { appendEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope, type GrowingFileIo } from './growing-file.js';
import { cardRecordStreamFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface RecordProjection { readonly cardId: string; readonly filename: string; readonly slot: AuthoredRecordSlot; readonly version: number; readonly recordUrl: string; readonly artifact: RecordVersionArtifact }

function slotFor(filename: string): AuthoredRecordSlot {
  const slot = basename(filename).replace(/\.(?:md|json)$/u, '');
  if (!authoredRecordSlotValues.includes(slot as AuthoredRecordSlot)) throw new Error(`Unsupported record slot '${filename}'.`);
  return slot as AuthoredRecordSlot;
}
function projection(artifact: RecordVersionArtifact): RecordProjection {
  const filename = `${artifact.slot}.md`;
  return Object.freeze({ cardId: artifact.card_id, filename, slot: artifact.slot, version: artifact.version, recordUrl: `record:///${filename}?card=${encodeURIComponent(artifact.card_id)}&v=${artifact.version}`, artifact });
}
function rows(projectRoot: string, cardId: string, slot: AuthoredRecordSlot): RecordVersionArtifact[] {
  if (!readCard(projectRoot, cardId)) throw new Error(`Card '${cardId}' does not exist.`);
  const path = cardRecordStreamFile(projectRoot, cardId, slot);
  try { return validateRecordStream(readCanonicalGrowingFile(path, recordVersionArtifactSchema), path, cardId, slot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && slot !== 'brief') return [];
    throw error;
  }
}
function append(projectRoot: string, artifact: RecordVersionArtifact, temporary?: PublicationTemporaryIdFactory, io?: GrowingFileIo): RecordProjection {
  const path = cardRecordStreamFile(projectRoot, artifact.card_id, artifact.slot);
  const prior = rows(projectRoot, artifact.card_id, artifact.slot);
  validateRecordStream([...prior, artifact], path, artifact.card_id, artifact.slot);
  const bytes = serializeGrowingEnvelope([artifact], recordVersionArtifactSchema);
  if (prior.length === 0) publishFirstEnvelope(path, bytes, temporary); else appendEnvelope(path, bytes, io);
  return projection(artifact);
}
export function readAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection {
  const slot = slotFor(filename); const all = rows(projectRoot, cardId, slot);
  let artifact: RecordVersionArtifact | undefined;
  if (version === 'open') artifact = all.at(-1)?.state === 'open' ? all.at(-1) : undefined;
  else if (version === 'latest') artifact = [...all].reverse().find((row) => row.state === 'closed');
  else artifact = [...all].reverse().find((row) => row.version === version);
  if (!artifact) throw new Error(`Record '${cardId}/${slot}/${String(version)}' does not exist.`);
  return projection(artifact);
}
export function openAuthoredRecord(projectRoot: string, cardId: string, filename: string, temporary?: PublicationTemporaryIdFactory, io?: GrowingFileIo): RecordProjection {
  const slot = slotFor(filename);
  const all = rows(projectRoot, cardId, slot); const current = all.at(-1);
  if (current?.state === 'open') return projection(current);
  const version = (current?.version ?? 0) + 1; const path = cardRecordStreamFile(projectRoot, cardId, slot);
  return append(projectRoot, parseRecordVersionArtifact({ kind: 'record-revision', format_version: 1, card_id: cardId, slot, version, revision_seq: all.length + 1, state: 'open', opened_at: new Date().toISOString(), committed_at: null, closed_at: null, discarded_at: null, reason: null, writer: null, format: 'markdown', schema: `record.${slot}.markdown.v1`, card_version_seq: null, content: '' }, path, { cardId, slot, version }), temporary, io);
}
function requireOpen(projectRoot: string, cardId: string, filename: string, version: number): { current: RecordVersionArtifact; count: number } {
  const slot = slotFor(filename); const all = rows(projectRoot, cardId, slot); const current = all.at(-1);
  if (!current || current.version !== version || current.state !== 'open') throw new Error(`Record '${cardId}/${slot}/${version}' is not open.`);
  return { current, count: all.length };
}
export function replaceOpenAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, content: string, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, filename, version);
  return append(projectRoot, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, content }, cardRecordStreamFile(projectRoot, cardId, current.slot), { cardId, slot: current.slot, version }), undefined, io);
}
export function closeAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, filename, version); const stamp = new Date().toISOString();
  return append(projectRoot, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, state: 'closed', committed_at: stamp, closed_at: stamp, writer, card_version_seq: cardVersionSeq }, cardRecordStreamFile(projectRoot, cardId, current.slot), { cardId, slot: current.slot, version }), undefined, io);
}
export function discardAuthoredRecord(projectRoot: string, cardId: string, filename: string, version: number, reason: string, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, filename, version);
  return append(projectRoot, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, state: 'discarded', discarded_at: new Date().toISOString(), reason }, cardRecordStreamFile(projectRoot, cardId, current.slot), { cardId, slot: current.slot, version }), undefined, io);
}
