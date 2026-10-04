import { randomUUID } from 'node:crypto';
import {
  sha256Hex,
  type AgentName,
  type CardRecord,
  type RecordDefinition,
} from '../schemas/index.js';
import {
  authoredRecordVersionArtifactSchema,
  recordHeadSchema,
  isEmptyRecordContent,
  type AcceptedRecordSnapshot,
  type AuthoredRecordVersionArtifact,
  type RecordHead,
  type OpenRecordDraft,
  type AcceptedRecordReference,
} from './canonical-record-artifacts.js';
import {
  readCanonicalBytes,
  readCanonicalBytesOrMissing,
  type CanonicalReadInstrumentation,
} from './growing-file.js';
import {
  cardRecordHeadFile,
  cardRecordPreviousHeadFile,
  cardAcceptedRecordFile,
} from './layout.js';
import { publishHeadFile } from './publish-head.js';
import {
  publishFreshFile,
  type PublicationTemporaryIdFactory,
  type ReplacementFileIo,
} from './replace-file.js';
import { readCommittedCardCurrent } from './card-files.js';

export interface RecordProjection {
  readonly cardId: string;
  readonly filename: string;
  readonly revision: number;
  readonly headId: string | null;
  readonly currentUrl: string;
  readonly acceptedVersionUrl: string | null;
  readonly state: 'open' | 'closed' | 'empty';
  readonly accepted: AcceptedRecordSnapshot | null;
  readonly draft: OpenRecordDraft | null;
}
export interface AcceptedRecordProjection extends RecordProjection {
  readonly artifact: AuthoredRecordVersionArtifact;
  readonly versionUrl: string;
}
export class AuthoredRecordNotFoundError extends Error {
  constructor() {
    super('Authored record not found.');
    this.name = 'AuthoredRecordNotFoundError';
  }
}
export type CurrentAuthoredRecordClassification =
  | Readonly<{ kind: 'unclaimed' | 'empty' }>
  | Readonly<{ kind: 'present'; projection: RecordProjection }>;

function exactIdentity(
  value: RecordHead | AuthoredRecordVersionArtifact,
  cardId: string,
  definition: RecordDefinition,
): void {
  if (
    value.card_id !== cardId ||
    value.record_name !== definition.filename ||
    value.record_format !== definition.format ||
    value.schema !== definition.schema
  )
    throw new Error(`Record '${cardId}/${definition.filename}' exact identity mismatch.`);
}
function bytes(value: RecordHead | AuthoredRecordVersionArtifact): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
function parseJson(data: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}
function readHead(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  instrumentation?: CanonicalReadInstrumentation,
): RecordHead | null {
  const data = readCanonicalBytesOrMissing(
    cardRecordHeadFile(projectRoot, cardId, definition),
    instrumentation,
  );
  if (data === null) {
    if (definition.bootstrap)
      throw new Error(`Required bootstrap record '${cardId}/${definition.filename}' missing.`);
    return null;
  }
  return decodeHead(cardId, definition, data);
}
function decodeHead(cardId: string, definition: RecordDefinition, data: Buffer): RecordHead {
  const head = recordHeadSchema.parse(parseJson(data));
  exactIdentity(head, cardId, definition);
  if (definition.bootstrap && head.accepted === null)
    throw new Error('Bootstrap record has no accepted selection.');
  return head;
}

/** Repair-only supplied-selector inspection sharing ordinary definition/content/hash checks. */
export function inspectAuthoredRecordSelection(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  data: Buffer,
  instrumentation?: CanonicalReadInstrumentation,
): { readonly head: RecordHead; readonly projection: RecordProjection } {
  const head = decodeHead(cardId, definition, data);
  return { head, projection: currentProjection(projectRoot, definition, head, instrumentation) };
}

/** Caller owns offline consent/recheck; the selection remains call-local, never write authority. */
export function restoreAuthoredRecordSelection(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  selection: RecordHead,
  mode: 'initial' | 'replacement',
): void {
  const head = recordHeadSchema.parse({ ...selection, head_id: randomUUID() });
  exactIdentity(head, cardId, definition);
  publishHeadFile(
    cardRecordHeadFile(projectRoot, cardId, definition),
    cardRecordPreviousHeadFile(projectRoot, cardId, definition),
    bytes(head),
    mode,
  );
}
function readAccepted(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  reference: AcceptedRecordReference,
  instrumentation?: CanonicalReadInstrumentation,
): AuthoredRecordVersionArtifact {
  const artifact = authoredRecordVersionArtifactSchema.parse(
    parseJson(
      readCanonicalBytes(
        cardAcceptedRecordFile(projectRoot, cardId, reference.entry_id),
        instrumentation,
      ),
    ),
  );
  exactIdentity(artifact, cardId, definition);
  if (artifact.entry_id !== reference.entry_id || artifact.version !== reference.version)
    throw new Error('Accepted record reference identity mismatch.');
  if (
    definition.bootstrap &&
    artifact.predecessor === null &&
    (artifact.version !== 1 ||
      !['runtime:bootstrap', 'runtime:repair'].includes(artifact.accepted.writer_agent))
  )
    throw new Error('Invalid bootstrap accepted origin.');
  if (
    artifact.accepted.writer_agent === 'runtime:bootstrap' &&
    (!definition.bootstrap || artifact.version !== 1 || artifact.predecessor !== null)
  )
    throw new Error('Invalid runtime bootstrap acceptance.');
  return artifact;
}
function project(
  definition: RecordDefinition,
  head: Omit<RecordHead, 'head_id'> & { readonly head_id: string | null },
  accepted: AcceptedRecordSnapshot | null,
): RecordProjection {
  const currentUrl = `record:///${encodeURIComponent(definition.filename)}?card=${encodeURIComponent(head.card_id)}`;
  return Object.freeze({
    cardId: head.card_id,
    filename: definition.filename,
    revision: head.revision,
    headId: head.head_id,
    currentUrl,
    acceptedVersionUrl: accepted ? `${currentUrl}&v=${accepted.source_version}` : null,
    state: head.draft ? 'open' : accepted ? 'closed' : 'empty',
    accepted,
    draft: head.draft,
  });
}
function projectAuthoredRecordArtifact(
  definition: RecordDefinition,
  artifact: AuthoredRecordVersionArtifact,
): AcceptedRecordProjection {
  const projection = project(
    definition,
    {
      ...identity(artifact.card_id, definition),
      head_id: null,
      revision: artifact.version,
      draft: null,
      accepted: reference(artifact),
    },
    artifact.accepted,
  );
  return Object.freeze({ ...projection, artifact, versionUrl: projection.acceptedVersionUrl! });
}
function currentProjection(
  projectRoot: string,
  definition: RecordDefinition,
  head: RecordHead,
  instrumentation?: CanonicalReadInstrumentation,
): RecordProjection {
  return project(
    definition,
    head,
    head.accepted
      ? readAccepted(projectRoot, head.card_id, definition, head.accepted, instrumentation).accepted
      : null,
  );
}
export function classifyCurrentAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentAuthoredRecordClassification {
  const head = readHead(projectRoot, card.id, definition, instrumentation);
  return head
    ? {
        kind: 'present',
        projection: currentProjection(projectRoot, definition, head, instrumentation),
      }
    : { kind: definition.declared ? 'empty' : 'unclaimed' };
}
export function readCurrentAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  instrumentation?: CanonicalReadInstrumentation,
): RecordProjection | null {
  const result = classifyCurrentAuthoredRecord(projectRoot, card, definition, instrumentation);
  return result.kind === 'present' ? result.projection : null;
}
function readAcceptedHistory(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  stopAt: number,
  instrumentation?: CanonicalReadInstrumentation,
): AuthoredRecordVersionArtifact[] {
  const rows: AuthoredRecordVersionArtifact[] = [];
  let selected = readHead(projectRoot, card.id, definition, instrumentation)?.accepted ?? null;
  while (selected) {
    const artifact = readAccepted(projectRoot, card.id, definition, selected, instrumentation);
    rows.push(artifact);
    if (artifact.version <= stopAt) break;
    selected = artifact.predecessor;
  }
  return rows;
}
export function readAuthoredRecordVersionPair(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  pivots: { from: number; to: number },
  instrumentation?: CanonicalReadInstrumentation,
): { from: AcceptedRecordProjection | null; to: AcceptedRecordProjection | null } {
  const rows = readAcceptedHistory(projectRoot, card, definition, pivots.from, instrumentation);
  const select = (version: number) => {
    const artifact = rows.find((row) => row.version === version);
    return artifact ? projectAuthoredRecordArtifact(definition, artifact) : null;
  };
  return { from: select(pivots.from), to: select(pivots.to) };
}
export function readAuthoredRecordVersion(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  version: number,
  instrumentation?: CanonicalReadInstrumentation,
): AcceptedRecordProjection | null {
  const artifact = readAcceptedHistory(
    projectRoot,
    card,
    definition,
    version,
    instrumentation,
  ).find((row) => row.version === version);
  return artifact ? projectAuthoredRecordArtifact(definition, artifact) : null;
}
export function listAuthoredRecordVersions(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  instrumentation?: CanonicalReadInstrumentation,
) {
  const versions: AuthoredRecordVersionArtifact[] = [];
  let selected = readHead(projectRoot, card.id, definition, instrumentation)?.accepted ?? null;
  while (selected) {
    const artifact = readAccepted(projectRoot, card.id, definition, selected, instrumentation);
    versions.push(artifact);
    selected = artifact.predecessor;
  }
  return { cardId: card.id, filename: definition.filename, versions: versions.reverse() };
}
function identity(cardId: string, definition: RecordDefinition) {
  return {
    format_version: 1 as const,
    kind: 'record-head' as const,
    card_id: cardId,
    record_name: definition.filename,
    record_format: definition.format,
    schema: definition.schema,
  };
}
function reference(artifact: AuthoredRecordVersionArtifact): AcceptedRecordReference {
  return { entry_id: artifact.entry_id, version: artifact.version };
}
function publishHead(
  projectRoot: string,
  definition: RecordDefinition,
  head: RecordHead,
  initial: boolean,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): void {
  const path = cardRecordHeadFile(projectRoot, head.card_id, definition);
  publishHeadFile(
    path,
    cardRecordPreviousHeadFile(projectRoot, head.card_id, definition),
    bytes(head),
    initial ? 'initial' : 'replacement',
    temporary,
    io,
  );
}
function draft(stamp: string, openedAt = stamp, content = ''): OpenRecordDraft {
  return { opened_at: openedAt, updated_at: stamp, content, content_sha256: sha256Hex(content) };
}
export function openAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): RecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (prior?.draft) return currentProjection(projectRoot, definition, prior);
  const accepted = prior ? currentProjection(projectRoot, definition, prior).accepted : null;
  const head = recordHeadSchema.parse({
    ...identity(card.id, definition),
    head_id: randomUUID(),
    revision: (prior?.revision ?? 0) + 1,
    accepted: prior?.accepted ?? null,
    draft: draft(new Date().toISOString()),
  });
  publishHead(projectRoot, definition, head, prior === null, io, temporary);
  return project(definition, head, accepted);
}
export function editOpenAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  content: string,
  io?: ReplacementFileIo,
): RecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (!prior?.draft) throw new Error('Record is not open.');
  const accepted = currentProjection(projectRoot, definition, prior).accepted;
  if (prior.draft.content === content) throw new Error('Record open edit must change content.');
  const head = recordHeadSchema.parse({
    ...prior,
    head_id: randomUUID(),
    revision: prior.revision + 1,
    draft: draft(new Date().toISOString(), prior.draft.opened_at, content),
  });
  publishHead(projectRoot, definition, head, false, io);
  return project(definition, head, accepted);
}
function publishAcceptance(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  prior: RecordHead | null,
  content: string,
  writer: AgentName | 'runtime:bootstrap' | 'runtime:repair',
  cardVersionSeq: number,
  cardHistory: AcceptedRecordSnapshot['card_history'],
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): RecordProjection {
  if (isEmptyRecordContent(content)) throw new Error('Record content must not be empty.');
  const stamp = new Date().toISOString();
  const entryId = randomUUID();
  const version = (prior?.revision ?? 0) + 1;
  const artifact = authoredRecordVersionArtifactSchema.parse({
    ...identity(cardId, definition),
    kind: 'accepted-record',
    entry_id: entryId,
    version,
    published_at: stamp,
    predecessor: prior?.accepted ?? null,
    accepted: {
      source_version: version,
      source_entry_id: entryId,
      committed_at: stamp,
      writer_agent: writer,
      card_version_seq: cardVersionSeq,
      card_history: cardHistory,
      content,
      content_sha256: sha256Hex(content),
      size_bytes: Buffer.byteLength(content),
    },
  });
  const head = recordHeadSchema.parse({
    ...identity(cardId, definition),
    head_id: randomUUID(),
    revision: version,
    accepted: reference(artifact),
    draft: null,
  });
  publishFreshFile(
    cardAcceptedRecordFile(projectRoot, cardId, entryId),
    bytes(artifact),
    temporary,
    io,
  );
  publishHead(projectRoot, definition, head, prior === null, io, temporary);
  return project(definition, head, artifact.accepted);
}
function acceptanceCard(projectRoot: string, cardId: string) {
  const current = readCommittedCardCurrent(projectRoot, cardId);
  if (current.kind !== 'found' || current.value.artifact.kind !== 'card-version')
    throw new AuthoredRecordNotFoundError();
  return {
    revision: current.value.card.version_seq,
    history: { entry_id: current.value.artifact.entry_id, version: current.value.artifact.version },
  };
}
export function acceptAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  content: string,
  writer: AgentName,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): RecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (prior?.draft) throw new Error('Record already has an open workflow draft.');
  const accepted = prior ? currentProjection(projectRoot, definition, prior).accepted : null;
  if (accepted?.content === content) throw new Error('Record content is unchanged.');
  const observed = acceptanceCard(projectRoot, card.id);
  return publishAcceptance(
    projectRoot,
    card.id,
    definition,
    prior,
    content,
    writer,
    observed.revision,
    observed.history,
    io,
    temporary,
  );
}
export function closeOpenAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  writer: AgentName,
  io?: ReplacementFileIo,
): RecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (!prior?.draft) throw new Error('Record is not open.');
  const observed = acceptanceCard(projectRoot, card.id);
  return publishAcceptance(
    projectRoot,
    card.id,
    definition,
    prior,
    prior.draft.content,
    writer,
    observed.revision,
    observed.history,
    io,
  );
}
export function discardOpenAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  io?: ReplacementFileIo,
): RecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (!prior?.draft) throw new Error('Record is not open.');
  const accepted = currentProjection(projectRoot, definition, prior).accepted;
  const head = recordHeadSchema.parse({
    ...prior,
    head_id: randomUUID(),
    revision: prior.revision + 1,
    draft: null,
  });
  publishHead(projectRoot, definition, head, false, io);
  return project(definition, head, accepted);
}
export function initializeAuthoredRecord(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  cardHistory: AcceptedRecordSnapshot['card_history'],
  bootstrapContent?: string,
  temporary?: PublicationTemporaryIdFactory,
): RecordProjection | null {
  if (bootstrapContent === undefined) return null;
  if (!definition.bootstrap)
    throw new Error('Only the bootstrap record accepts bootstrap content.');
  return publishAcceptance(
    projectRoot,
    cardId,
    definition,
    null,
    bootstrapContent,
    'runtime:bootstrap',
    1,
    cardHistory,
    undefined,
    temporary,
  );
}

/** Explicit discard owns initial absence and new-card provenance, not recovered acceptance. */
export function initializeRepairAuthoredRecord(
  projectRoot: string,
  cardId: string,
  definition: RecordDefinition,
  cardHistory: AcceptedRecordSnapshot['card_history'],
  content: string,
): void {
  publishAcceptance(
    projectRoot,
    cardId,
    definition,
    null,
    content,
    'runtime:repair',
    1,
    cardHistory,
  );
}
