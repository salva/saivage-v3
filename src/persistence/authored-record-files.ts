import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';

import type { AgentName } from '../schemas/index.js';
import type { RecordDefinition } from '../records/record-definition.js';
import {
  authoredRecordVersionArtifactSchema,
  authoredRecordVersionIndexSchema,
  recordContentSha256,
  isEmptyRecordContent,
  recordEntryFromArtifact,
  validateRecordArtifactIdentity,
  type AcceptedRecordSnapshot,
  type AuthoredRecordVersionArtifact,
  type AuthoredRecordVersionIndex,
  type RecordVersionEntry,
} from './canonical-record-artifacts.js';
import { readCard } from './card-files.js';
import { cardRecordRoot, cardRecordVersionFile, cardRecordVersionIndexFile, cardRecordVersionsRoot } from './layout.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';
import { createImmutableVersionFile, serializeStrictJson, type ImmutableVersionFileIo } from './version-file.js';
import { versionFilename } from './version-index.js';
import type { CanonicalReadInstrumentation } from './growing-file.js';

export interface RecordProjection {
  readonly cardId: string;
  readonly filename: string;
  readonly headVersion: number;
  readonly currentUrl: string;
  readonly versionUrl: string;
  readonly artifact: AuthoredRecordVersionArtifact;
}
export interface RecordVersionCatalog { readonly cardId: string; readonly filename: string; readonly versions: readonly RecordVersionEntry[]; readonly current: RecordProjection | null }

export class AuthoredRecordNotFoundError extends Error { constructor() { super('Authored record not found.'); this.name = 'AuthoredRecordNotFoundError'; } }
export class AuthoredRecordDefinitionNotFoundError extends Error { constructor() { super('Authored record definition not found.'); this.name = 'AuthoredRecordDefinitionNotFoundError'; } }
export class AuthoredRecordHistoricalUnavailableError extends Error { constructor(readonly version: number, readonly reason: 'missing' | 'corrupt' | 'io_error') { super(`Historical authored-record version ${version} is ${reason}.`); this.name = 'AuthoredRecordHistoricalUnavailableError'; } }
export class RecordHeadMismatchError extends Error { constructor(readonly currentHead: number | null) { super('Record head did not match expected head.'); this.name = 'RecordHeadMismatchError'; } }

function projection(definition: RecordDefinition, artifact: AuthoredRecordVersionArtifact): RecordProjection {
  const currentUrl = `record:///${definition.filename}?card=${encodeURIComponent(artifact.card_id)}`;
  return Object.freeze({ cardId: artifact.card_id, filename: definition.filename, headVersion: artifact.version, currentUrl, versionUrl: `${currentUrl}&v=${artifact.version}`, artifact });
}

function parseJson<T>(path: string, schema: { parse(value: unknown): T }, instrumentation?: CanonicalReadInstrumentation): T {
  instrumentation?.onRead(path); const bytes = readFileSync(path); let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new Error(`Canonical JSON file '${path}' is malformed.`, { cause: error }); }
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error(`Canonical JSON file '${path}' must contain one newline-terminated JSON object.`);
  try { return schema.parse(JSON.parse(text.slice(0, -1))); } catch (error) { throw new Error(`Canonical JSON file '${path}' is malformed.`, { cause: error }); }
}

function readIndex(projectRoot: string, cardId: string, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): AuthoredRecordVersionIndex {
  if (!readCard(projectRoot, cardId, instrumentation)) throw new AuthoredRecordNotFoundError();
  const index = parseJson(cardRecordVersionIndexFile(projectRoot, cardId, definition), authoredRecordVersionIndexSchema, instrumentation);
  if (index.card_id !== cardId || index.record_name !== definition.filename || index.record_format !== definition.format || index.schema !== definition.schema) throw new Error('Authored-record index does not match configured identity.');
  return index;
}

function readArtifact(projectRoot: string, cardId: string, definition: RecordDefinition, index: AuthoredRecordVersionIndex, entry: RecordVersionEntry, instrumentation?: CanonicalReadInstrumentation): AuthoredRecordVersionArtifact {
  const artifact = parseJson(cardRecordVersionFile(projectRoot, cardId, definition, entry.filename), authoredRecordVersionArtifactSchema, instrumentation);
  validateRecordArtifactIdentity(artifact, index, entry, definition);
  return artifact;
}

export function emptyAuthoredRecordIndex(cardId: string, definition: RecordDefinition): AuthoredRecordVersionIndex {
  return authoredRecordVersionIndexSchema.parse({ format_version: 1, kind: 'authored-record-version-index', card_id: cardId, record_name: definition.filename, record_format: definition.format, schema: definition.schema, versions: [], current_version: null, current_filename: null });
}

function publishIndex(projectRoot: string, cardId: string, definition: RecordDefinition, index: AuthoredRecordVersionIndex, temporary?: PublicationTemporaryIdFactory): void {
  replaceFile(cardRecordVersionIndexFile(projectRoot, cardId, definition), serializeStrictJson(authoredRecordVersionIndexSchema.parse(index)), temporary);
}

export function initializeAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, bootstrapContent?: string, temporary?: PublicationTemporaryIdFactory): RecordProjection | null {
  mkdirSync(cardRecordRoot(projectRoot, cardId, definition)); mkdirSync(cardRecordVersionsRoot(projectRoot, cardId, definition));
  publishIndex(projectRoot, cardId, definition, emptyAuthoredRecordIndex(cardId, definition), temporary);
  if (bootstrapContent === undefined) return null;
  if (!definition.bootstrap) throw new Error('Only the configured bootstrap record accepts bootstrap content.');
  const stamp = new Date().toISOString(); const entryId = randomUUID();
  const accepted: AcceptedRecordSnapshot = { source_version: 1, source_entry_id: entryId, committed_at: stamp, writer_agent: 'runtime:bootstrap', card_version_seq: 1, content: bootstrapContent, content_sha256: recordContentSha256(bootstrapContent), size_bytes: Buffer.byteLength(bootstrapContent, 'utf8') };
  return publishArtifact(projectRoot, cardId, definition, emptyAuthoredRecordIndex(cardId, definition), authoredRecordVersionArtifactSchema.parse({ format_version: 1, kind: 'authored-record-version', entry_id: entryId, card_id: cardId, record_name: definition.filename, record_format: definition.format, schema: definition.schema, version: 1, published_at: stamp, state: 'closed', accepted, draft: null, discarded: null }));
}
function ensureDirectory(path: string): void { try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!lstatSync(path).isDirectory()) throw new Error(`Required authored-record path '${path}' is not a directory.`); } }
export function initializeMissingOptionalAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, temporary?: PublicationTemporaryIdFactory): boolean {
  if (definition.bootstrap) throw new Error('Required bootstrap records cannot be recreated as empty.');
  try { readIndex(projectRoot, cardId, definition); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  ensureDirectory(cardRecordRoot(projectRoot, cardId, definition)); ensureDirectory(cardRecordVersionsRoot(projectRoot, cardId, definition)); publishIndex(projectRoot, cardId, definition, emptyAuthoredRecordIndex(cardId, definition), temporary); return true;
}

export function readCurrentAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): RecordProjection | null {
  const index = readIndex(projectRoot, cardId, definition, instrumentation); const entry = index.versions.at(-1); if (!entry) return null;
  return projection(definition, readArtifact(projectRoot, cardId, definition, index, entry, instrumentation));
}

export function listAuthoredRecordVersions(projectRoot: string, cardId: string, definition: RecordDefinition, instrumentation?: CanonicalReadInstrumentation): RecordVersionCatalog {
  const index = readIndex(projectRoot, cardId, definition, instrumentation);
  return Object.freeze({ cardId, filename: definition.filename, versions: index.versions, current: null });
}

export function readHistoricalAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, version: number, instrumentation?: CanonicalReadInstrumentation): RecordProjection {
  const index = readIndex(projectRoot, cardId, definition, instrumentation); const entry = index.versions[version - 1]; if (!entry) throw new AuthoredRecordNotFoundError();
  try { return projection(definition, readArtifact(projectRoot, cardId, definition, index, entry, instrumentation)); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; throw new AuthoredRecordHistoricalUnavailableError(version, code === 'ENOENT' ? 'missing' : code ? 'io_error' : 'corrupt'); }
}

function currentForWrite(projectRoot: string, cardId: string, definition: RecordDefinition, expectedHead: number | null): { index: AuthoredRecordVersionIndex; current: AuthoredRecordVersionArtifact | null } {
  const index = readIndex(projectRoot, cardId, definition); const entry = index.versions.at(-1); const currentHead = entry?.version ?? null;
  if (currentHead !== expectedHead) throw new RecordHeadMismatchError(currentHead);
  return { index, current: entry ? readArtifact(projectRoot, cardId, definition, index, entry) : null };
}

function publishArtifact(projectRoot: string, cardId: string, definition: RecordDefinition, index: AuthoredRecordVersionIndex, artifact: AuthoredRecordVersionArtifact, io?: ImmutableVersionFileIo, temporary?: PublicationTemporaryIdFactory): RecordProjection {
  const filename = versionFilename(artifact.version, randomUUID(), 'json'); const entry = recordEntryFromArtifact(artifact, filename);
  const next = authoredRecordVersionIndexSchema.parse({ ...index, versions: [...index.versions, entry], current_version: artifact.version, current_filename: filename });
  validateTransition(index.versions.at(-1), artifact, definition);
  createImmutableVersionFile(cardRecordVersionFile(projectRoot, cardId, definition, filename), serializeStrictJson(artifact), io);
  publishIndex(projectRoot, cardId, definition, next, temporary); return projection(definition, artifact);
}

function validateTransition(priorEntry: RecordVersionEntry | undefined, artifact: AuthoredRecordVersionArtifact, definition: RecordDefinition): void {
  if (artifact.version !== (priorEntry?.version ?? 0) + 1) throw new Error('Authored-record version must advance exactly once.');
  if (!priorEntry) {
    if (definition.bootstrap ? artifact.state !== 'closed' || artifact.accepted?.writer_agent !== 'runtime:bootstrap' : artifact.state !== 'open' || artifact.accepted !== null || artifact.draft?.content !== '' || artifact.draft.opened_at !== artifact.published_at || artifact.draft.updated_at !== artifact.published_at) throw new Error('Authored-record first version is invalid.');
  }
}

function draft(stamp: string, openedAt = stamp, content = '') { return { opened_at: openedAt, updated_at: stamp, content, content_sha256: recordContentSha256(content) }; }

export function openAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, expectedHead: number | null, io?: ImmutableVersionFileIo): RecordProjection {
  const { index, current } = currentForWrite(projectRoot, cardId, definition, expectedHead); if (current?.state === 'open') return projection(definition, current);
  const stamp = new Date().toISOString(); const version = (current?.version ?? 0) + 1;
  const artifact = authoredRecordVersionArtifactSchema.parse({ format_version: 1, kind: 'authored-record-version', entry_id: randomUUID(), card_id: cardId, record_name: definition.filename, record_format: definition.format, schema: definition.schema, version, published_at: stamp, state: 'open', accepted: current?.accepted ?? null, draft: draft(stamp), discarded: null });
  return publishArtifact(projectRoot, cardId, definition, index, artifact, io);
}

export function editOpenAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, expectedHead: number, content: string, io?: ImmutableVersionFileIo): RecordProjection {
  const { index, current } = currentForWrite(projectRoot, cardId, definition, expectedHead); if (!current || current.state !== 'open' || !current.draft) throw new Error(`Record '${cardId}/${definition.filename}' is not open.`); if (current.draft.content === content) throw new Error('Record open edit must change content.');
  const stamp = new Date().toISOString(); const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: randomUUID(), version: current.version + 1, published_at: stamp, draft: draft(stamp, current.draft.opened_at, content) });
  return publishArtifact(projectRoot, cardId, definition, index, artifact, io);
}

export function closeOpenAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, expectedHead: number, writer: AgentName, io?: ImmutableVersionFileIo): RecordProjection {
  const { index, current } = currentForWrite(projectRoot, cardId, definition, expectedHead); if (!current || current.state !== 'open' || !current.draft) throw new Error(`Record '${cardId}/${definition.filename}' is not open.`); if (!definition.writers.includes(writer)) throw new Error(`Agent '${writer}' is not a configured writer for '${definition.filename}'.`);
  if (isEmptyRecordContent(current.draft.content)) throw new Error('Record content must not be empty.');
  const card = readCard(projectRoot, cardId); if (!card) throw new AuthoredRecordNotFoundError();
  const stamp = new Date().toISOString(); const version = current.version + 1; const accepted: AcceptedRecordSnapshot = { source_version: version, source_entry_id: randomUUID(), committed_at: stamp, writer_agent: writer, card_version_seq: card.version_seq, content: current.draft.content, content_sha256: current.draft.content_sha256, size_bytes: Buffer.byteLength(current.draft.content, 'utf8') };
  const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: accepted.source_entry_id, version, published_at: stamp, state: 'closed', accepted, draft: null, discarded: null });
  return publishArtifact(projectRoot, cardId, definition, index, artifact, io);
}

export function discardOpenAuthoredRecord(projectRoot: string, cardId: string, definition: RecordDefinition, expectedHead: number, reason: string, io?: ImmutableVersionFileIo): RecordProjection {
  const { index, current } = currentForWrite(projectRoot, cardId, definition, expectedHead); if (!current || current.state !== 'open') throw new Error(`Record '${cardId}/${definition.filename}' is not open.`);
  const stamp = new Date().toISOString(); const artifact = authoredRecordVersionArtifactSchema.parse({ ...current, entry_id: randomUUID(), version: current.version + 1, published_at: stamp, state: 'discarded', draft: null, discarded: { discarded_at: stamp, reason } });
  return publishArtifact(projectRoot, cardId, definition, index, artifact, io);
}
