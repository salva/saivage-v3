import { randomUUID } from 'node:crypto';
import {
  sha256Hex,
  type AgentName,
  type RecordAuthor,
  type CardRecord,
  type RecordDefinition,
} from '../schemas/index.js';
import {
  authoredRecordVersionArtifactSchema,
  recordHeadSchema,
  isEmptyRecordContent,
  isEligibleRecordContent,
  type AcceptedRecordSnapshot,
  type AuthoredRecordVersionArtifact,
  type RecordHead,
  type OpenRecordDraft,
  type AcceptedRecordReference,
  type RecordBaseline,
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
import type { CanonicalCardProjection } from './card-files.js';

interface RecordProjectionIdentity {
  readonly cardId: string;
  readonly filename: string;
  readonly currentUrl: string;
  readonly acceptedVersionUrl: string | null;
}
export interface CurrentRecordProjection extends RecordProjectionIdentity {
  readonly revision: number;
  readonly headId: string;
  readonly state: 'baseline' | 'open' | 'closed' | 'empty';
  readonly baseline: RecordBaseline | null;
  readonly accepted: AcceptedRecordSnapshot | null;
  readonly draft: OpenRecordDraft | null;
}
export interface AcceptedRecordProjection extends RecordProjectionIdentity {
  readonly revision: null;
  readonly headId: null;
  readonly state: 'closed';
  readonly baseline: null;
  readonly draft: null;
  readonly accepted: AcceptedRecordSnapshot;
  readonly artifact: AuthoredRecordVersionArtifact;
  readonly versionUrl: string;
}
export type RecordProjection = CurrentRecordProjection | AcceptedRecordProjection;
export class AuthoredRecordNotFoundError extends Error {
  constructor() {
    super('Authored record not found.');
    this.name = 'AuthoredRecordNotFoundError';
  }
}
export type CurrentAuthoredRecordClassification =
  | Readonly<{ kind: 'unclaimed' | 'empty' }>
  | Readonly<{ kind: 'present'; projection: CurrentRecordProjection }>;

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
): { readonly head: RecordHead; readonly projection: CurrentRecordProjection } {
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
    (artifact.version !== 1 || artifact.accepted.author.kind === 'shell-stdout')
  )
    throw new Error('Invalid bootstrap accepted origin.');
  if (
    artifact.accepted.author.kind === 'runtime' &&
    artifact.accepted.author.purpose === 'bootstrap' &&
    (!definition.bootstrap || artifact.version !== 1 || artifact.predecessor !== null)
  )
    throw new Error('Invalid runtime bootstrap acceptance.');
  if (definition.bootstrap && artifact.accepted.author.kind === 'shell-stdout')
    throw new Error('Shell stdout cannot author a bootstrap record.');
  return artifact;
}
function project(
  definition: RecordDefinition,
  head: RecordHead,
  accepted: AcceptedRecordSnapshot | null,
): CurrentRecordProjection {
  const currentUrl = `record:///${encodeURIComponent(definition.filename)}?card=${encodeURIComponent(head.card_id)}`;
  return Object.freeze({
    cardId: head.card_id,
    filename: definition.filename,
    revision: head.revision,
    headId: head.head_id,
    currentUrl,
    acceptedVersionUrl: accepted ? `${currentUrl}&v=${accepted.source_version}` : null,
    state: head.baseline ? 'baseline' : head.draft ? 'open' : accepted ? 'closed' : 'empty',
    baseline: head.baseline,
    accepted,
    draft: head.draft,
  });
}
function projectAuthoredRecordArtifact(
  definition: RecordDefinition,
  artifact: AuthoredRecordVersionArtifact,
): AcceptedRecordProjection {
  const currentUrl = `record:///${encodeURIComponent(definition.filename)}?card=${encodeURIComponent(artifact.card_id)}`;
  const versionUrl = `${currentUrl}&v=${artifact.version}`;
  return Object.freeze({
    cardId: artifact.card_id,
    filename: definition.filename,
    headId: null,
    revision: null,
    baseline: null,
    draft: null,
    state: 'closed',
    accepted: artifact.accepted,
    currentUrl,
    acceptedVersionUrl: versionUrl,
    artifact,
    versionUrl,
  });
}
function currentProjection(
  projectRoot: string,
  definition: RecordDefinition,
  head: RecordHead,
  instrumentation?: CanonicalReadInstrumentation,
): CurrentRecordProjection {
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
): CurrentRecordProjection | null {
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
  const versions = [
    ...iterateAuthoredRecordVersions(projectRoot, card, definition, instrumentation),
  ];
  return { cardId: card.id, filename: definition.filename, versions: versions.reverse() };
}

/** Exact selected predecessors, newest first; callers may yield between owning reads. */
export function* iterateAuthoredRecordVersions(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  instrumentation?: CanonicalReadInstrumentation,
): Generator<AuthoredRecordVersionArtifact> {
  let selected = readHead(projectRoot, card.id, definition, instrumentation)?.accepted ?? null;
  while (selected) {
    const artifact = readAccepted(projectRoot, card.id, definition, selected, instrumentation);
    yield artifact;
    selected = artifact.predecessor;
  }
}
function identity(cardId: string, definition: RecordDefinition) {
  return {
    card_id: cardId,
    record_name: definition.filename,
    record_format: definition.format,
    schema: definition.schema,
  };
}
function headIdentity(cardId: string, definition: RecordDefinition) {
  return {
    ...identity(cardId, definition),
    format_version: 3 as const,
    kind: 'record-head' as const,
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
function draft(
  stamp: string,
  openedAt: string,
  content: string,
  version: number,
  targetVersion: number,
): OpenRecordDraft {
  return {
    opened_at: openedAt,
    updated_at: stamp,
    content,
    content_sha256: sha256Hex(content),
    version,
    target_version: targetVersion,
  };
}
export function openAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): CurrentRecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (prior?.draft) return currentProjection(projectRoot, definition, prior);
  const accepted = prior ? currentProjection(projectRoot, definition, prior).accepted : null;
  const stamp = new Date().toISOString();
  const head = recordHeadSchema.parse({
    ...headIdentity(card.id, definition),
    head_id: randomUUID(),
    revision: (prior?.revision ?? 0) + 1,
    accepted: prior?.accepted ?? null,
    baseline: null,
    draft: draft(
      stamp,
      stamp,
      prior?.baseline?.content ?? '',
      prior?.baseline ? 0 : (prior?.accepted?.version ?? 0) + 1,
      (prior?.accepted?.version ?? 0) + 1,
    ),
  });
  publishHead(projectRoot, definition, head, prior === null, io, temporary);
  return project(definition, head, accepted);
}
/** Exact absence alone authorizes rendering; an established empty head is present. */
export function initializeRecordBaseline(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  render: () => string,
  io?: ReplacementFileIo,
): CurrentRecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (prior) return currentProjection(projectRoot, definition, prior);
  if (definition.bootstrap) throw new Error('Bootstrap records cannot have a template baseline.');
  const content = render();
  const head = recordHeadSchema.parse({
    ...headIdentity(card.id, definition),
    head_id: randomUUID(),
    revision: 1,
    baseline: {
      version: 0,
      created_at: new Date().toISOString(),
      content,
      content_sha256: sha256Hex(content),
    },
    draft: null,
    accepted: null,
  });
  publishHead(projectRoot, definition, head, true, io);
  return project(definition, head, null);
}
export function editOpenAuthoredRecord(
  projectRoot: string,
  card: CardRecord,
  definition: RecordDefinition,
  content: string,
  io?: ReplacementFileIo,
): CurrentRecordProjection {
  const prior = readHead(projectRoot, card.id, definition);
  if (!prior?.draft) throw new Error('Record is not open.');
  const accepted = currentProjection(projectRoot, definition, prior).accepted;
  if (prior.draft.content === content) throw new Error('Record open edit must change content.');
  if (isEmptyRecordContent(content)) throw new Error('Record content must not be empty.');
  const head = recordHeadSchema.parse({
    ...prior,
    head_id: randomUUID(),
    revision: prior.revision + 1,
    draft: draft(
      new Date().toISOString(),
      prior.draft.opened_at,
      content,
      prior.draft.target_version,
      prior.draft.target_version,
    ),
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
  author: RecordAuthor,
  cardVersionSeq: number,
  cardHistory: AcceptedRecordSnapshot['card_history'],
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): CurrentRecordProjection {
  if (isEmptyRecordContent(content)) throw new Error('Record content must not be empty.');
  const stamp = new Date().toISOString();
  const entryId = randomUUID();
  const version = (prior?.accepted?.version ?? 0) + 1;
  const artifact = authoredRecordVersionArtifactSchema.parse({
    ...identity(cardId, definition),
    format_version: 4,
    kind: 'accepted-record',
    entry_id: entryId,
    version,
    published_at: stamp,
    predecessor: prior?.accepted ?? null,
    accepted: {
      source_version: version,
      source_entry_id: entryId,
      committed_at: stamp,
      author,
      card_version_seq: cardVersionSeq,
      card_history: cardHistory,
      content,
      content_sha256: sha256Hex(content),
      size_bytes: Buffer.byteLength(content),
    },
  });
  const head = recordHeadSchema.parse({
    ...headIdentity(cardId, definition),
    head_id: randomUUID(),
    revision: (prior?.revision ?? 0) + 1,
    baseline: null,
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
function acceptanceCard(projection: CanonicalCardProjection) {
  if (projection.artifact.kind !== 'card-version') throw new AuthoredRecordNotFoundError();
  return {
    revision: projection.card.version_seq,
    history: { entry_id: projection.artifact.entry_id, version: projection.artifact.version },
  };
}
export function acceptAuthoredRecord(
  projectRoot: string,
  projection: CanonicalCardProjection,
  definition: RecordDefinition,
  content: string,
  author: RecordAuthor,
  io?: ReplacementFileIo,
  temporary?: PublicationTemporaryIdFactory,
): CurrentRecordProjection {
  const cardId = projection.card.id;
  if (definition.bootstrap && author.kind === 'shell-stdout')
    throw new Error('Shell stdout cannot author a bootstrap record.');
  const prior = readHead(projectRoot, cardId, definition);
  if (prior?.draft) throw new Error('Record already has an open workflow draft.');
  const accepted = prior ? currentProjection(projectRoot, definition, prior).accepted : null;
  if (author.kind !== 'shell-stdout' && (prior?.baseline?.content ?? accepted?.content) === content)
    throw new Error('Record content is unchanged.');
  const observed = acceptanceCard(projection);
  return publishAcceptance(
    projectRoot,
    cardId,
    definition,
    prior,
    content,
    author,
    observed.revision,
    observed.history,
    io,
    temporary,
  );
}
export function closeOpenAuthoredRecord(
  projectRoot: string,
  projection: CanonicalCardProjection,
  definition: RecordDefinition,
  writer: AgentName,
  io?: ReplacementFileIo,
): CurrentRecordProjection {
  const cardId = projection.card.id;
  const prior = readHead(projectRoot, cardId, definition);
  if (!prior?.draft) throw new Error('Record is not open.');
  if (!isEligibleRecordContent({ draft: prior.draft, accepted: null }))
    throw new Error('Record draft is empty or document 0; authored content is required.');
  const observed = acceptanceCard(projection);
  return publishAcceptance(
    projectRoot,
    cardId,
    definition,
    prior,
    prior.draft.content,
    { kind: 'agent', agent: writer },
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
): CurrentRecordProjection {
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
  author: RecordAuthor,
  bootstrapContent?: string,
  temporary?: PublicationTemporaryIdFactory,
): CurrentRecordProjection | null {
  if (bootstrapContent === undefined) return null;
  if (!definition.bootstrap)
    throw new Error('Only the bootstrap record accepts bootstrap content.');
  return publishAcceptance(
    projectRoot,
    cardId,
    definition,
    null,
    bootstrapContent,
    author,
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
    { kind: 'runtime', purpose: 'repair' },
    1,
    cardHistory,
  );
}
