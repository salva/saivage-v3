import type { AgentRole } from '../schemas/index.js';
import type { RecordDefinition } from '../records/current-record-definitions.js';
import { parseRecordVersionArtifact, recordVersionArtifactSchema, validateRecordStream, type AuthoredRecordSlot, type RecordVersionArtifact } from './canonical-record-artifacts.js';
import { readCard } from './card-files.js';
import { appendEnvelope, publishFirstEnvelope, readCanonicalGrowingFile, serializeGrowingEnvelope, type CanonicalReadInstrumentation, type GrowingFileIo } from './growing-file.js';
import { cardRecordStreamFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface RecordProjection { readonly cardId: string; readonly filename: string; readonly slot: AuthoredRecordSlot; readonly version: number; readonly recordUrl: string; readonly artifact: RecordVersionArtifact }

export class AuthoredRecordNotFoundError extends Error {
  constructor() {
    super('Authored record not found.');
    this.name = 'AuthoredRecordNotFoundError';
  }
}

function projection(definition: RecordDefinition, artifact: RecordVersionArtifact): RecordProjection {
  const filename = definition.filename;
  return Object.freeze({ cardId: artifact.card_id, filename, slot: artifact.slot, version: artifact.version, recordUrl: `record:///${filename}?card=${encodeURIComponent(artifact.card_id)}&v=${artifact.version}`, artifact });
}
function rows(projectRoot: string, cardId: string, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): RecordVersionArtifact[] {
  if (!readCard(projectRoot, cardId, instrumentation)) throw new AuthoredRecordNotFoundError();
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  try { return validateRecordStream(readCanonicalGrowingFile(path, recordVersionArtifactSchema, undefined, instrumentation), path, cardId, definition); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !definition.bootstrap) return [];
    throw error;
  }
}
function append(projectRoot: string, definition: RecordDefinition, artifact: RecordVersionArtifact, temporary?: PublicationTemporaryIdFactory, io?: GrowingFileIo): RecordProjection {
  const path = cardRecordStreamFile(projectRoot, artifact.card_id, definition);
  const prior = rows(projectRoot, artifact.card_id, definition);
  validateRecordStream([...prior, artifact], path, artifact.card_id, definition);
  const bytes = serializeGrowingEnvelope([artifact], recordVersionArtifactSchema);
  if (prior.length === 0) publishFirstEnvelope(path, bytes, temporary);
  else {
    const result = appendEnvelope(path, bytes, io);
    switch (result.kind) {
      case 'appended': break;
      case 'missing': throw new Error(`Authored-record stream '${path}' disappeared before append.`);
    }
  }
  return projection(definition, artifact);
}
export function readAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, version: number | 'latest' | 'open' = 'latest', instrumentation?: CanonicalReadInstrumentation): RecordProjection {
  const all = rows(projectRoot, cardId, definition, instrumentation);
  let artifact: RecordVersionArtifact | undefined;
  if (version === 'open') artifact = all.at(-1)?.state === 'open' ? all.at(-1) : undefined;
  else if (version === 'latest') artifact = [...all].reverse().find((row) => row.state === 'closed');
  else artifact = [...all].reverse().find((row) => row.version === version);
  if (!artifact) throw new AuthoredRecordNotFoundError();
  return projection(definition, artifact);
}
export function openAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, temporary?: PublicationTemporaryIdFactory, io?: GrowingFileIo): RecordProjection {
  const all = rows(projectRoot, cardId, definition); const current = all.at(-1);
  if (current?.state === 'open') return projection(definition, current);
  const version = (current?.version ?? 0) + 1; const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const artifact = parseRecordVersionArtifact({ kind: 'record-revision', format_version: 1, card_id: cardId, slot: definition.slot, version, revision_seq: all.length + 1, state: 'open', opened_at: new Date().toISOString(), committed_at: null, closed_at: null, discarded_at: null, reason: null, writer: null, format: definition.format, schema: definition.schema, card_version_seq: null, content: '' }, path, { cardId, definition, version });
  return append(projectRoot, definition, artifact, temporary, io);
}
function requireOpen(projectRoot: string, cardId: string, definition: RecordDefinition, version: number): { current: RecordVersionArtifact; count: number } {
  const all = rows(projectRoot, cardId, definition); const current = all.at(-1);
  if (!current || current.version !== version || current.state !== 'open') throw new Error(`Record '${cardId}/${definition.slot}/${version}' is not open.`);
  return { current, count: all.length };
}
export function replaceOpenAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, version: number, content: string, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, definition, version);
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  return append(projectRoot, definition, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, content }, path, { cardId, definition, version }), undefined, io);
}
export function closeAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, version: number, writer: AgentRole, cardVersionSeq: number, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, definition, version); const stamp = new Date().toISOString();
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  return append(projectRoot, definition, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, state: 'closed', committed_at: stamp, closed_at: stamp, writer, card_version_seq: cardVersionSeq }, path, { cardId, definition, version }), undefined, io);
}
export function discardAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, version: number, reason: string, io?: GrowingFileIo): RecordProjection {
  const { current, count } = requireOpen(projectRoot, cardId, definition, version);
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  return append(projectRoot, definition, parseRecordVersionArtifact({ ...current, revision_seq: count + 1, state: 'discarded', discarded_at: new Date().toISOString(), reason }, path, { cardId, definition, version }), undefined, io);
}
