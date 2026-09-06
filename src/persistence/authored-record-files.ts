import { randomUUID } from 'node:crypto';

import type { AgentName, CardRecord } from '../schemas/index.js';
import type { RecordDefinition } from '../records/record-definition.js';
import {
  authoredRecordVersionArtifactSchema,
  recordContentSha256,
  isEmptyRecordContent,
  validateRecordStream,
  type AcceptedRecordSnapshot,
  type AuthoredRecordVersionArtifact,
} from './canonical-record-artifacts.js';
import { appendEnvelope, publishFirstEnvelope, readStrictCanonicalGrowingFile, serializeGrowingEnvelope, type CanonicalReadInstrumentation, type GrowingFileIo } from './growing-file.js';
import { cardRecordStreamFile } from './layout.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';

export interface RecordProjection {
  readonly cardId: string;
  readonly filename: string;
  readonly headVersion: number;
  readonly currentUrl: string;
  readonly versionUrl: string;
  readonly artifact: AuthoredRecordVersionArtifact;
}
export interface RecordVersionCatalog { readonly cardId: string; readonly filename: string; readonly versions: readonly AuthoredRecordVersionArtifact[]; readonly current: RecordProjection | null }

export class AuthoredRecordNotFoundError extends Error { constructor() { super('Authored record not found.'); this.name = 'AuthoredRecordNotFoundError'; } }
export class AuthoredRecordDefinitionNotFoundError extends Error { constructor() { super('Authored record definition not found.'); this.name = 'AuthoredRecordDefinitionNotFoundError'; } }
export type CurrentAuthoredRecordClassification = Readonly<{ kind:'unclaimed'|'empty' }> | Readonly<{kind:'present';projection:RecordProjection}>;

export function projectAuthoredRecordArtifact(definition: RecordDefinition, artifact: AuthoredRecordVersionArtifact): RecordProjection {
  const currentUrl = `record:///${definition.filename}?card=${encodeURIComponent(artifact.card_id)}`;
  return Object.freeze({ cardId: artifact.card_id, filename: definition.filename, headVersion: artifact.version, currentUrl, versionUrl: `${currentUrl}&v=${artifact.version}`, artifact });
}

function readStreamRows(projectRoot: string, cardId: string, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): readonly AuthoredRecordVersionArtifact[] | null {
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  let rows: AuthoredRecordVersionArtifact[];
  try { rows = readStrictCanonicalGrowingFile(path, authoredRecordVersionArtifactSchema, instrumentation); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  validateRecordStream(rows, path, cardId, definition);
  return rows;
}

export function classifyCurrentAuthoredRecord(projectRoot:string,card:CardRecord,definition:RecordDefinition,instrumentation?:CanonicalReadInstrumentation):CurrentAuthoredRecordClassification{
  const rows = readStreamRows(projectRoot,card.id,definition,instrumentation);
  if(rows===null)return Object.freeze({kind:definition.declared?'empty':'unclaimed'});
  return Object.freeze({kind:'present',projection:projectAuthoredRecordArtifact(definition,rows.at(-1)!)});
}

export function initializeAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, bootstrapContent?: string, temporary?: PublicationTemporaryIdFactory): RecordProjection | null {
  if (bootstrapContent === undefined) return null;
  if (!definition.bootstrap) throw new Error('Only the configured bootstrap record accepts bootstrap content.');
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const stamp = new Date().toISOString(); const entryId = randomUUID();
  const accepted: AcceptedRecordSnapshot = { source_version: 1, source_entry_id: entryId, committed_at: stamp, writer_agent: 'runtime:bootstrap', card_version_seq: 1, content: bootstrapContent, content_sha256: recordContentSha256(bootstrapContent), size_bytes: Buffer.byteLength(bootstrapContent, 'utf8') };
  const artifact = authoredRecordVersionArtifactSchema.parse({ format_version: 1, kind: 'authored-record-version', entry_id: entryId, card_id: cardId, record_name: definition.filename, record_format: definition.format, schema: definition.schema, version: 1, published_at: stamp, state: 'closed', accepted, draft: null, discarded: null });
  validateRecordStream([artifact], path, cardId, definition);
  publishFirstEnvelope(path, serializeGrowingEnvelope([artifact], authoredRecordVersionArtifactSchema), temporary);
  return projectAuthoredRecordArtifact(definition, artifact);
}

export function readCurrentAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): RecordProjection | null {
  const classified=classifyCurrentAuthoredRecord(projectRoot,card,definition,instrumentation);return classified.kind==='present'?classified.projection:null;
}

function requireRecordStream(projectRoot: string, card: CardRecord, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): readonly AuthoredRecordVersionArtifact[] {
  const rows = readStreamRows(projectRoot,card.id,definition,instrumentation);
  if(rows===null)throw new AuthoredRecordNotFoundError();
  return rows;
}

export function listAuthoredRecordVersions(projectRoot: string, card: CardRecord, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): RecordVersionCatalog {
  const rows = readStreamRows(projectRoot, card.id, definition, instrumentation);
  if (rows === null) {
    return Object.freeze({ cardId:card.id, filename: definition.filename, versions: [], current: null });
  }
  return Object.freeze({ cardId:card.id, filename: definition.filename, versions: rows, current: null });
}

export function readHistoricalAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, version: number, instrumentation?: CanonicalReadInstrumentation): RecordProjection {
  const rows = requireRecordStream(projectRoot, card, definition, instrumentation); const row = rows[version - 1];
  if (!row || row.version !== version) throw new AuthoredRecordNotFoundError();
  return projectAuthoredRecordArtifact(definition, row);
}

function publishRow(path: string, rows: readonly AuthoredRecordVersionArtifact[] | null, artifact: AuthoredRecordVersionArtifact, cardId: string, definition: RecordDefinition, io?: GrowingFileIo, temporary?: PublicationTemporaryIdFactory): void {
  validateRecordStream(rows === null ? [artifact] : [...rows, artifact], path, cardId, definition);
  const bytes = serializeGrowingEnvelope([artifact], authoredRecordVersionArtifactSchema);
  if (rows === null) { publishFirstEnvelope(path, bytes, temporary); return; }
  const result = appendEnvelope(path, bytes, io);
  if (result.kind === 'missing') throw new Error(`Authored-record stream '${path}' is missing for append.`);
}

function draft(stamp: string, openedAt = stamp, content = '') { return { opened_at: openedAt, updated_at: stamp, content, content_sha256: recordContentSha256(content) }; }

export function openAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, io?: GrowingFileIo, temporary?: PublicationTemporaryIdFactory): RecordProjection {
  const cardId=card.id;
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const rows = readStreamRows(projectRoot, cardId, definition); const current = rows?.at(-1) ?? null;
  if (current?.state === 'open') return projectAuthoredRecordArtifact(definition, current);
  const stamp = new Date().toISOString(); const version = (current?.version ?? 0) + 1;
  const artifact = authoredRecordVersionArtifactSchema.parse({ format_version: 1, kind: 'authored-record-version', entry_id: randomUUID(), card_id: cardId, record_name: definition.filename, record_format: definition.format, schema: definition.schema, version, published_at: stamp, state: 'open', accepted: current?.accepted ?? null, draft: draft(stamp), discarded: null });
  publishRow(path, rows, artifact, cardId, definition, io, temporary);
  return projectAuthoredRecordArtifact(definition, artifact);
}

export function editOpenAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, content: string, io?: GrowingFileIo): RecordProjection {
  const cardId=card.id;
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const rows = readStreamRows(projectRoot, cardId, definition); const current = rows?.at(-1) ?? null;
  if (!current || current.state !== 'open' || !current.draft) throw new Error(`Record '${cardId}/${definition.filename}' is not open.`); if (current.draft.content === content) throw new Error('Record open edit must change content.');
  const stamp = new Date().toISOString(); const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: randomUUID(), version: current.version + 1, published_at: stamp, draft: draft(stamp, current.draft.opened_at, content) });
  publishRow(path, rows, artifact, cardId, definition, io);
  return projectAuthoredRecordArtifact(definition, artifact);
}

export function closeOpenAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, writer: AgentName, io?: GrowingFileIo): RecordProjection {
  const cardId=card.id;
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const rows = readStreamRows(projectRoot, cardId, definition); const current = rows?.at(-1) ?? null;
  if (!current || current.state !== 'open' || !current.draft) throw new Error(`Record '${cardId}/${definition.filename}' is not open.`);
  if (isEmptyRecordContent(current.draft.content)) throw new Error('Record content must not be empty.');
  const stamp = new Date().toISOString(); const version = current.version + 1; const accepted: AcceptedRecordSnapshot = { source_version: version, source_entry_id: randomUUID(), committed_at: stamp, writer_agent: writer, card_version_seq: card.version_seq, content: current.draft.content, content_sha256: current.draft.content_sha256, size_bytes: Buffer.byteLength(current.draft.content, 'utf8') };
  const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: accepted.source_entry_id, version, published_at: stamp, state: 'closed', accepted, draft: null, discarded: null });
  publishRow(path, rows, artifact, cardId, definition, io);
  return projectAuthoredRecordArtifact(definition, artifact);
}

export function discardOpenAuthoredRecord(projectRoot: string, card: CardRecord, definition: RecordDefinition, reason: string, io?: GrowingFileIo): RecordProjection {
  const cardId=card.id;
  const path = cardRecordStreamFile(projectRoot, cardId, definition);
  const rows = readStreamRows(projectRoot, cardId, definition); const current = rows?.at(-1) ?? null;
  if (!current || current.state !== 'open') throw new Error(`Record '${cardId}/${definition.filename}' is not open.`);
  const stamp = new Date().toISOString(); const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: randomUUID(), version: current.version + 1, published_at: stamp, state: 'discarded', draft: null, discarded: { discarded_at: stamp, reason } });
  publishRow(path, rows, artifact, cardId, definition, io);
  return projectAuthoredRecordArtifact(definition, artifact);
}
