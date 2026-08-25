import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';

import type { FreshnessEffects } from '../application/freshness-effects.js';
import { projectCanonicalConversationRow } from '../application/read-models/canonical-conversation-outbound.js';
import { validateCompactedHistorySuccessor, validateConversation, type CompactedGenesisSeed, type ValidatedConversation } from '../contracts/conversation-validation.js';
import { currentCoveredRequiredFactRows } from '../runtime/actors/context/composition-projector.js';
import { agentMessageSchema, conversationSessionIdentity, type AgentMessage, type CompactedHistory, type ConversationSessionId, type RequiredModelFactSlots } from '../schemas/index.js';
import { projectToolInvocation } from '../tools/tool-invocation-outbound.js';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import {
  conversationSegmentEnvelopeSchema,
  conversationVersionIndexSchema,
  canonicalValueSha256,
  conversationSha256,
  type ConversationContinuation,
  type ConversationSegmentGenesis,
  type ConversationVersionEntry,
  type ConversationVersionIndex,
} from './canonical-conversation-artifacts.js';
import { appendEnvelope, type GrowingFileIo } from './growing-file.js';
import {
  cardConversationRoot,
  cardConversationVersionFile,
  cardConversationVersionIndexFile,
  cardConversationVersionsRoot,
  globalAgentConversationRoot,
  globalAgentConversationVersionFile,
  globalAgentConversationVersionIndexFile,
  globalAgentConversationVersionsRoot,
} from './layout.js';
import { replaceFile, type PublicationTemporaryIdFactory } from './replace-file.js';
import { createImmutableVersionFile, serializeStrictJson } from './version-file.js';
import { versionFilename } from './version-index.js';

export interface ConversationFileContext { readonly projectRoot: string; readonly changes?: Pick<FreshnessEffects, 'conversationChanged' | 'agentMembershipChanged'> }
export interface ConversationAppendOptions { readonly publicationTemporaryId?: PublicationTemporaryIdFactory; readonly io?: GrowingFileIo }
interface ConversationTruncationIo { open(path: string, flags: number): number; ftruncate(fd: number, length: number): void; fsync(fd: number): void; close(fd: number): void }
export interface FoldedConversation { readonly sessionId: ConversationSessionId; readonly entries: readonly AgentMessage[]; readonly cursor: string | null; readonly totalEntries: number; readonly segmentVersion: number; readonly segmentContext: ConversationSegmentContext }
export type ConversationSegmentContext = null | { readonly kind: 'compacted'; readonly source_version: number; readonly covered_through_message_id: string; readonly summary_text: string; readonly source_kind: 'current_rows' | 'prior_genesis_plus_current_rows'; readonly prior_genesis_id: string | null; readonly prior_history_hash: string | null; readonly covered_group_count: number; readonly dispositions: CompactedHistory['dispositionCommitment']; readonly coverage: CompactedHistory['coverageCommitment']; readonly required_model_facts: RequiredModelFactSlots; readonly continuation: ConversationContinuation };
export interface ConversationCatalog { readonly sessionId: ConversationSessionId; readonly createdAt: string; readonly versions: readonly ConversationVersionEntry[]; readonly currentVersion: number | null }
export interface ConversationSegment { readonly index: ConversationVersionIndex; readonly entry: ConversationVersionEntry; readonly genesis: ConversationSegmentGenesis; readonly rows: readonly AgentMessage[]; readonly bytes: Buffer; readonly conversation: ValidatedConversation }
export class ConversationSegmentChangedError extends Error { constructor(readonly requestedVersion: number, readonly currentVersion: number) { super('Conversation segment changed.'); } }
export class ConversationHistoricalVersionNotFoundError extends Error {}
export class ConversationHistoricalVersionUnavailableError extends Error { constructor(readonly version: number, readonly reason: 'missing'|'corrupt'|'io_error') { super('Historical conversation segment unavailable.'); } }
function validationSeeds(genesis: ConversationSegmentGenesis): { inherited: import('../contracts/conversation-validation.js').InheritedConversationActivation | undefined; compacted: CompactedGenesisSeed | undefined } {
  const inherited = genesis.kind === 'compacted_segment_genesis' && genesis.continuation.kind === 'inherited_open_round' ? { markerId: genesis.continuation.activation.marker_id, inputId: genesis.continuation.activation.input_id, activeSegmentKind: genesis.continuation.active_segment_kind, startOrdinal: 0 } : undefined;
  const compacted = genesis.kind === 'compacted_segment_genesis' ? { id: genesis.id, timestamp: genesis.timestamp, history: genesis.compaction, sourceVersion: genesis.source.version } : undefined;
  return { inherited, compacted };
}

interface ConversationLocation { readonly root: string; readonly versionsRoot: string; readonly indexPath: string; readonly versionPath: (filename: string) => string }
function location(projectRoot: string, sessionId: ConversationSessionId): ConversationLocation {
  const identity = conversationSessionIdentity(sessionId);
  const cardId = identity.cardId;
  return identity.cardId === null
    ? { root: globalAgentConversationRoot(projectRoot, identity.agentName), versionsRoot: globalAgentConversationVersionsRoot(projectRoot, identity.agentName), indexPath: globalAgentConversationVersionIndexFile(projectRoot, identity.agentName), versionPath: (filename) => globalAgentConversationVersionFile(projectRoot, identity.agentName, filename) }
    : { root: cardConversationRoot(projectRoot, cardId!, identity.agentName), versionsRoot: cardConversationVersionsRoot(projectRoot, cardId!, identity.agentName), indexPath: cardConversationVersionIndexFile(projectRoot, cardId!, identity.agentName), versionPath: (filename) => cardConversationVersionFile(projectRoot, cardId!, identity.agentName, filename) };
}
function decode(path: string, bytes: Buffer): string { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new Error(`Canonical file '${path}' is malformed.`, { cause: error }); } }
function parseIndex(path: string): ConversationVersionIndex {
  const text = decode(path, readFileSync(path));
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) throw new Error(`Conversation index '${path}' must contain one newline-terminated JSON object.`);
  try { return conversationVersionIndexSchema.parse(JSON.parse(text.slice(0, -1))); } catch (error) { throw new Error(`Conversation index '${path}' is malformed.`, { cause: error }); }
}
function parseSegment(path: string, suppliedBytes?: Buffer): { bytes: Buffer; genesis: ConversationSegmentGenesis; rows: AgentMessage[] } {
  const bytes = suppliedBytes ?? readFileSync(path); const text = decode(path, bytes);
  if (text.length === 0 || !text.endsWith('\n')) throw new Error(`Conversation segment '${path}' has an incomplete final envelope.`);
  const all: unknown[] = [];
  for (const [offset, line] of text.slice(0, -1).split('\n').entries()) {
    if (!line) throw new Error(`Conversation segment '${path}' envelope ${offset + 1} is empty.`);
    try { all.push(...conversationSegmentEnvelopeSchema.parse(JSON.parse(line)).rows); } catch (error) { throw new Error(`Conversation segment '${path}' envelope ${offset + 1} is malformed.`, { cause: error }); }
  }
  const [genesis, ...rows] = all;
  if (!genesis || (genesis as { kind?: string }).kind !== 'ordinary_segment_genesis' && (genesis as { kind?: string }).kind !== 'compacted_segment_genesis') throw new Error(`Conversation segment '${path}' must begin with exactly one genesis row.`);
  if (rows.some((row) => (row as { kind?: string }).kind === 'ordinary_segment_genesis' || (row as { kind?: string }).kind === 'compacted_segment_genesis')) throw new Error(`Conversation segment '${path}' contains a non-initial genesis row.`);
  return { bytes, genesis: genesis as ConversationSegmentGenesis, rows: rows.map((row) => agentMessageSchema.parse(row)) };
}
function emptyIndex(sessionId: ConversationSessionId): ConversationVersionIndex { return conversationVersionIndexSchema.parse({ format_version: 1, kind: 'conversation-version-index', session_id: sessionId, created_at: new Date().toISOString(), versions: [], current_version: null, current_filename: null }); }
function publishIndex(path: string, index: ConversationVersionIndex, temporary?: PublicationTemporaryIdFactory): void { replaceFile(path, serializeStrictJson(conversationVersionIndexSchema.parse(index)), temporary); }

export function initializeConversation(projectRoot: string, sessionId: ConversationSessionId, temporary?: PublicationTemporaryIdFactory): void {
  const target = location(projectRoot, sessionId); mkdirSync(target.root); mkdirSync(target.versionsRoot); publishIndex(target.indexPath, emptyIndex(sessionId), temporary);
}
function ensureDirectory(path: string): void { try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!lstatSync(path).isDirectory()) throw new Error(`Required conversation path '${path}' is not a directory.`); } }
export function initializeMissingConversation(projectRoot: string, sessionId: ConversationSessionId, temporary?: PublicationTemporaryIdFactory): boolean {
  const target = location(projectRoot, sessionId); try { parseIndex(target.indexPath); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  ensureDirectory(target.root); ensureDirectory(target.versionsRoot); publishIndex(target.indexPath, emptyIndex(sessionId), temporary); return true;
}
export function readConversationCatalog(projectRoot: string, sessionId: ConversationSessionId): ConversationCatalog {
  const index = parseIndex(location(projectRoot, sessionId).indexPath);
  if (index.session_id !== sessionId) throw new Error(`Conversation index identity does not match '${sessionId}'.`);
  return Object.freeze({ sessionId, createdAt: index.created_at, versions: index.versions, currentVersion: index.current_version });
}
function readSegment(projectRoot: string, sessionId: ConversationSessionId, version?: number, suppliedIndex?: ConversationVersionIndex): ConversationSegment | null {
  const target = location(projectRoot, sessionId); const index = suppliedIndex ?? parseIndex(target.indexPath);
  if (index.session_id !== sessionId) throw new Error(`Conversation index identity does not match '${sessionId}'.`);
  const entry = version === undefined ? index.versions.at(-1) : index.versions[version - 1];
  if (!entry) { if (version !== undefined) throw new ConversationHistoricalVersionNotFoundError(); return null; }
  const parsed = parseSegment(target.versionPath(entry.filename)); return validateLoadedSegment(index, entry, parsed, sessionId);
}
function validateLoadedSegment(index: ConversationVersionIndex, entry: ConversationVersionEntry, parsed: ReturnType<typeof parseSegment>, sessionId: ConversationSessionId): ConversationSegment {
  const { genesis, rows } = parsed;
  if (genesis.entry_id !== entry.entry_id || genesis.session_id !== sessionId || genesis.segment_version !== entry.version || genesis.kind === 'ordinary_segment_genesis' !== (entry.genesis.kind === 'ordinary')) throw new Error(`Conversation segment '${entry.filename}' does not match its index entry.`);
  if (genesis.kind === 'compacted_segment_genesis') {
    const tailRows = rows.slice(0, genesis.retained_rows.row_count);
    if (entry.genesis.kind !== 'compacted' || genesis.source.version !== entry.genesis.source_version || genesis.source.filename !== entry.genesis.source_filename || genesis.source.sha256 !== entry.genesis.source_sha256 || genesis.source.covered_through_message_id !== entry.genesis.covered_through_message_id || genesis.compaction.coverageCommitment.coveredThroughMessageId !== entry.genesis.covered_through_message_id || canonicalValueSha256(genesis.compaction) !== entry.genesis.compaction_payload_sha256 || canonicalValueSha256(genesis.continuation) !== entry.genesis.continuation_sha256 || canonicalValueSha256(tailRows) !== entry.genesis.retained_rows_sha256 || genesis.retained_rows.sha256 !== entry.genesis.retained_rows_sha256) throw new Error(`Compacted conversation segment '${entry.filename}' does not match its index genesis commitment.`);
    if (rows.length < genesis.retained_rows.row_count || tailRows[0]?.id !== (genesis.retained_rows.first_message_id ?? undefined) || tailRows.at(-1)?.id !== (genesis.retained_rows.last_message_id ?? undefined)) throw new Error(`Compacted conversation segment '${entry.filename}' retained-row metadata is invalid.`);
  }
  try {
    const { inherited, compacted } = validationSeeds(genesis);
    const conversation = validateConversation(sessionId, rows, inherited, compacted);
    return Object.freeze({ index, entry, genesis, rows: Object.freeze(rows), bytes: parsed.bytes, conversation });
  } catch (error) { throw new Error(`Conversation '${sessionId}' segment ${entry.version} is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
export function readCurrentConversationSegment(projectRoot: string, sessionId: ConversationSessionId): ConversationSegment | null { return readSegment(projectRoot, sessionId); }
export function readHistoricalConversationSegment(projectRoot: string, sessionId: ConversationSessionId, version: number): ConversationSegment {
  const target = location(projectRoot, sessionId);
  const index = parseIndex(target.indexPath);
  if (index.session_id !== sessionId) throw new Error(`Conversation index identity does not match '${sessionId}'.`);
  const entry = index.versions[version - 1];
  if (!entry) throw new ConversationHistoricalVersionNotFoundError();
  try { return validateLoadedSegment(index, entry, parseSegment(target.versionPath(entry.filename)), sessionId); }
  catch (error) { if (error instanceof ConversationHistoricalVersionNotFoundError) throw error; const code = (error as NodeJS.ErrnoException).code; throw new ConversationHistoricalVersionUnavailableError(version, code === 'ENOENT' ? 'missing' : code ? 'io_error' : 'corrupt'); }
}
export function readConversation(projectRoot: string, sessionId: ConversationSessionId): ValidatedConversation { return readSegment(projectRoot, sessionId)?.conversation ?? validateConversation(sessionId, []); }
export function foldConversation(projectRoot: string, sessionId: ConversationSessionId, options: { segmentVersion?: number; since?: string; lastN?: number } = {}): FoldedConversation {
  const segment = readSegment(projectRoot, sessionId); if (!segment) throw new ConversationHistoricalVersionNotFoundError();
  if (options.segmentVersion !== undefined && options.segmentVersion !== segment.entry.version) throw new ConversationSegmentChangedError(options.segmentVersion, segment.entry.version);
  const coveredFacts = coveredRequiredFactRows(segment);
  const rows = [...coveredFacts, ...segment.rows]; const selected: AgentMessage[] = []; let cursorFound = options.since === undefined; let cursor: string | null = options.since ?? null; let totalEntries = 0;
  for (const row of rows) {
    if (options.since !== undefined && !cursorFound) { if (row.id === options.since) cursorFound = true; continue; }
    if (row.kind === 'provider_private') continue;
    cursor = row.id;
    const clean = row.provider_projection ? stripProviderProjection(row) : row; selected.push(projectCanonicalConversationRow(clean, projectToolInvocation)); totalEntries += 1;
    if (options.lastN !== undefined && selected.length > options.lastN) selected.shift();
  }
  if (!cursorFound) throw new ConversationCursorNotFoundError(options.since!);
  return Object.freeze({ sessionId, entries: Object.freeze(selected), cursor, totalEntries, segmentVersion: segment.entry.version, segmentContext: segmentContext(segment.genesis) });
}
function coveredRequiredFactRows(segment: ConversationSegment): readonly AgentMessage[] {
  if (segment.genesis.kind !== 'compacted_segment_genesis') return [];
  return currentCoveredRequiredFactRows({
    sourceSessionId: segment.conversation.sourceSessionId,
    requiredModelFacts: segment.conversation.effectiveRequiredModelFacts,
    uncoveredRows: segment.conversation.sourceRows,
  });
}
export function segmentContext(genesis: ConversationSegmentGenesis): ConversationSegmentContext { return genesis.kind === 'ordinary_segment_genesis' ? null : Object.freeze({ kind: 'compacted', source_version: genesis.source.version, covered_through_message_id: genesis.source.covered_through_message_id, summary_text: genesis.compaction.summaryText, source_kind: genesis.compaction.source.kind, prior_genesis_id: genesis.compaction.source.kind === 'prior_genesis_plus_current_rows' ? genesis.compaction.source.priorGenesisId : null, prior_history_hash: genesis.compaction.source.kind === 'prior_genesis_plus_current_rows' ? genesis.compaction.source.priorHistoryHash : null, covered_group_count: genesis.compaction.source.groups.length, dispositions: genesis.compaction.dispositionCommitment, coverage: genesis.compaction.coverageCommitment, required_model_facts: genesis.compaction.requiredModelFacts, continuation: genesis.continuation }); }
export class ConversationCursorNotFoundError extends Error { constructor(readonly cursor: string) { super(`Conversation cursor '${cursor}' was not found.`); } }
function stripProviderProjection(row: AgentMessage): AgentMessage { const result = { ...row }; delete result.provider_projection; return agentMessageSchema.parse(result); }
function validateBatch(messages: readonly AgentMessage[]): AgentMessage[] { if (!messages.length) throw new Error('Conversation append requires at least one message.'); const parsed = messages.map((message) => agentMessageSchema.parse(message)); const sessionId = parsed[0]!.session_id; if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation append requires one session.'); if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation append contains duplicate message ids.'); return parsed; }
function segmentEnvelope(rows: readonly unknown[]): Buffer { return Buffer.from(`${JSON.stringify(conversationSegmentEnvelopeSchema.parse({ version: 1, type: 'conversation-segment', rows }))}\n`); }
function visibleMessageId(rows: readonly AgentMessage[]): string | null { return rows.filter((row) => row.kind !== 'provider_private').at(-1)?.id ?? null; }

export function appendConversationBatch(conversations: ConversationFileContext, messages: readonly AgentMessage[], options: ConversationAppendOptions = {}): void {
  const parsed = validateBatch(messages); const sessionId = parsed[0]!.session_id; const target = location(conversations.projectRoot, sessionId); const index = parseIndex(target.indexPath); if (index.session_id !== sessionId) throw new Error(`Conversation index identity does not match '${sessionId}'.`);
  const current = readSegment(conversations.projectRoot, sessionId, undefined, index);
  const existingIds = new Set(current?.rows.map((message) => message.id) ?? []); const duplicate = parsed.find((message) => existingIds.has(message.id)); if (duplicate) throw new Error(`Conversation message '${duplicate.id}' already exists.`);
  const prospectiveSeeds = current ? validationSeeds(current.genesis) : { inherited: undefined, compacted: undefined };
  validateConversation(sessionId, [...(current?.rows ?? []), ...parsed], prospectiveSeeds.inherited, prospectiveSeeds.compacted);
  let segmentVersion: number;
  if (!current) {
    const entryId = randomUUID(); const filename = versionFilename(1, randomUUID(), 'jsonl'); const timestamp = new Date().toISOString(); const genesis = { format_version: 1, kind: 'ordinary_segment_genesis', id: randomUUID(), entry_id: entryId, session_id: sessionId, segment_version: 1, timestamp } as const;
    const entry = { entry_id: entryId, version: 1, filename, created_at: timestamp, genesis: { kind: 'ordinary' } } as const; const next = conversationVersionIndexSchema.parse({ ...index, versions: [entry], current_version: 1, current_filename: filename });
    createImmutableVersionFile(target.versionPath(filename), segmentEnvelope([genesis, ...parsed])); publishIndex(target.indexPath, next, options.publicationTemporaryId); segmentVersion = 1;
  } else {
    const result = appendEnvelope(target.versionPath(current.entry.filename), segmentEnvelope(parsed), options.io); if (result.kind === 'missing') throw new Error(`Conversation '${sessionId}' disappeared before append.`); segmentVersion = current.entry.version;
  }
  conversations.changes?.conversationChanged({ session_id: sessionId, segment_version: segmentVersion, visible_message_id: visibleMessageId([...(current?.rows ?? []), ...parsed]) });
  if (!current) { const identity = conversationSessionIdentity(sessionId); conversations.changes?.agentMembershipChanged(identity.cardId === null ? { scope: 'global-session', sessionId } : { scope: 'card', cardId: identity.cardId }); }
}

export interface ConversationCompactionPublication {
  readonly identity: CompactionSuccessorIdentity;
  readonly history: CompactedHistory;
  readonly cutoffSourceIndex: number;
  readonly cutoffMessageId: string;
  readonly continuation: ConversationContinuation;
}

export type CompactionSuccessorIdentity = Readonly<{
  readonly genesisId: string;
  readonly segmentVersion: number;
  readonly entryId: string;
  readonly timestamp: string;
  readonly filename: string;
}>;

export interface CompactionPublicationIo {
  readonly createImmutableVersionFile: typeof createImmutableVersionFile;
  readonly replaceFile: typeof replaceFile;
}

export interface CompactionPublicationOptions {
  readonly temporary?: PublicationTemporaryIdFactory;
  readonly io?: CompactionPublicationIo;
}

export function publishCompactedConversationSegment(conversations: ConversationFileContext, sessionId: ConversationSessionId, compaction: ConversationCompactionPublication, options: CompactionPublicationOptions = {}): ValidatedConversation {
  const io = options.io ?? { createImmutableVersionFile, replaceFile };
  const target = location(conversations.projectRoot, sessionId); const current = readSegment(conversations.projectRoot, sessionId); if (!current) throw new Error(`Conversation '${sessionId}' has no source segment to compact.`);
  if (current.entry.version !== current.index.current_version || current.entry.filename !== current.index.current_filename) throw new Error('Conversation compaction source is not the current index head.');
  if (current.entry.version + 1 !== compaction.identity.segmentVersion) throw new Error('Compaction successor identity does not extend the still-current conversation head.');
  const sourceRows = current.conversation.sourceRows; if (sourceRows[compaction.cutoffSourceIndex]?.id !== compaction.cutoffMessageId) throw new Error('Conversation compaction cutoff does not identify the source segment.');
  const coveredRows = sourceRows.slice(0, compaction.cutoffSourceIndex + 1);
  const { inherited: currentInherited, compacted: currentCompacted } = validationSeeds(current.genesis);
  validateCompactedHistorySuccessor({ source: current.conversation, sourceGenesis: currentCompacted ?? null, sourceVersion: current.entry.version, successor: compaction.history, coveredRows });
  const tail = sourceRows.slice(compaction.cutoffSourceIndex + 1); const rows = tail;
  let inherited: import('../contracts/conversation-validation.js').InheritedConversationActivation | undefined;
  if (compaction.continuation.kind === 'inherited_open_round') {
    inherited = { markerId: compaction.continuation.activation.marker_id, inputId: compaction.continuation.activation.input_id, activeSegmentKind: compaction.continuation.active_segment_kind, startOrdinal: 0 };
  } else if (currentInherited && current.conversation.rounds.some((round) => round.state === 'open' && round.activation.source === 'compacted_genesis' && round.activation.marker_id === currentInherited.markerId && round.activation.input_id === currentInherited.inputId)) {
    throw new Error('A between-rounds cutoff cannot leave an inherited open activation with no retained row.');
  }
  const version = compaction.identity.segmentVersion; const entryId = compaction.identity.entryId; const timestamp = compaction.identity.timestamp; const filename = compaction.identity.filename;
  const retainedHash = canonicalValueSha256(rows); const sourceHash = conversationSha256(current.bytes); const payloadHash = canonicalValueSha256(compaction.history); const continuationHash = canonicalValueSha256(compaction.continuation);
  const genesis = { format_version: 1, kind: 'compacted_segment_genesis', id: compaction.identity.genesisId, entry_id: entryId, session_id: sessionId, segment_version: version, timestamp, source: { version: current.entry.version, filename: current.entry.filename, sha256: sourceHash, covered_through_message_id: compaction.cutoffMessageId }, compaction: compaction.history, continuation: compaction.continuation, retained_rows: { first_message_id: rows[0]?.id ?? null, last_message_id: rows.at(-1)?.id ?? null, row_count: rows.length, sha256: retainedHash } } as const;
  const entry = { entry_id: entryId, version, filename, created_at: timestamp, genesis: { kind: 'compacted', source_version: current.entry.version, source_filename: current.entry.filename, source_sha256: sourceHash, covered_through_message_id: compaction.cutoffMessageId, compaction_payload_sha256: payloadHash, continuation_sha256: continuationHash, retained_rows_sha256: retainedHash } } as const;
  const next = conversationVersionIndexSchema.parse({ ...current.index, versions: [...current.index.versions, entry], current_version: version, current_filename: filename });
  const successor = validateConversation(sessionId, rows, inherited, { id: compaction.identity.genesisId, timestamp, history: compaction.history, sourceVersion: current.entry.version });
  io.createImmutableVersionFile(target.versionPath(filename), segmentEnvelope([genesis, ...rows]));
  io.replaceFile(target.indexPath, serializeStrictJson(next), options.temporary);
  conversations.changes?.conversationChanged({ session_id: sessionId, segment_version: version, visible_message_id: visibleMessageId(rows) });
  return successor;
}

const conversationTruncationIo: ConversationTruncationIo = { open: openSync, ftruncate: ftruncateSync, fsync: fsyncSync, close: closeSync };

export function truncateCurrentConversationUnterminatedSuffix(projectRoot: string, sessionId: ConversationSessionId, io: ConversationTruncationIo = conversationTruncationIo): ConversationSegment | null {
  const target = location(projectRoot, sessionId); const index = parseIndex(target.indexPath);
  if (index.session_id !== sessionId) throw new Error(`Conversation index identity does not match '${sessionId}'.`);
  const entry = index.versions.at(-1); if (!entry) return null;
  const path = target.versionPath(entry.filename); const bytes = readFileSync(path);
  if (bytes.at(-1) === 0x0a) return validateLoadedSegment(index, entry, parseSegment(path, bytes), sessionId);
  const finalNewline = bytes.lastIndexOf(0x0a);
  if (finalNewline < 0) throw new Error(`Conversation segment '${path}' has no complete prefix before its unterminated suffix.`);
  const length = finalNewline + 1;
  const segment = validateLoadedSegment(index, entry, parseSegment(path, bytes.subarray(0, length)), sessionId);
  const descriptor = io.open(path, constants.O_RDWR);
  try { io.ftruncate(descriptor, length); } catch { throw new PublicationOutcomeUnknownError(); }
  try { io.fsync(descriptor); } catch { throw new PublicationOutcomeUnknownError(); }
  try { io.close(descriptor); } catch { throw new PublicationOutcomeUnknownError(); }
  return segment;
}
