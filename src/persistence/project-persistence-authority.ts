import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AgentRole, CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { runtimeStateSchema } from '../schemas/index.js';
import {
  assertRuntimeLifecycleLock,
  type RuntimeLifecycleLockHandle,
} from '../runtime/lock.js';
import { parseCardVersionArtifact } from './canonical-card-artifacts.js';
import { authoredRecordSlotValues, parseRecordVersionArtifact, type AuthoredRecordSlot, type RecordVersionArtifact } from './canonical-record-artifacts.js';
import { observeCanonicalProjectRoot } from './canonical-root-observation.js';
import {
  discardIncompleteCardNamespace,
  hasCanonicalCardArtifact,
  restabilizeCanonicalStore,
  validateIncompleteCardNamespace,
  type CanonicalStoreGeneration,
} from './canonical-store-scan.js';
import {
  cleanupDurableReplacementTemporaries,
  durableReplacementTemporaryTargetBasename,
  durablyReplaceFile,
  publishDirectory,
} from './durable-file-replacement.js';
import { IndeterminatePublicationError } from './errors.js';

const GENERATED_ROOTS = new Set(['cards', 'agents', 'state', 'logs', 'work', 'stages', 'locks']);
const PRESERVED_SAIVAGE_ENTRIES = new Set([
  'project.json',
  'saivage.yaml',
  'saivage.json',
  'auth-profiles.json',
  'config',
  'skills',
  'instructions',
  'backups',
]);

declare const bootstrapEligibilityBrand: unique symbol;

export interface BootstrapEligibility {
  readonly [bootstrapEligibilityBrand]: never;
  readonly canonicalProjectRoot: string;
}

const issuedEligibility = new WeakSet<object>();

export interface NewProjectRootInput {
  readonly card: CardRecord;
  readonly brief: string;
}

export type PersistenceOpenMode =
  | { readonly kind: 'normal' }
  | { readonly kind: 'bootstrap'; readonly root: NewProjectRootInput };

export type PersistenceAuthorityState = 'closed' | 'exclusive-restabilization' | 'open' | 'failed';

export interface ProjectPersistenceAuthority {
  readonly projectRoot: string;
  readonly state: PersistenceAuthorityState;
  readonly generation: CanonicalStoreGeneration;
  readonly reader: ProjectCardRecordReader;
  readonly writer: ProjectCardRecordWriter;
  close(): void;
}

export interface RecordProjection {
  readonly cardId: string;
  readonly filename: string;
  readonly slot: 'brief' | 'status' | 'review';
  readonly version: number;
  readonly recordUrl: string;
  readonly artifact: ReturnType<typeof parseRecordVersionArtifact>;
}

export interface ProjectCardRecordReader {
  generation(): CanonicalStoreGeneration;
  record(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection;
}

export interface ProjectMutationSession {
  createCard(card: CardRecord, brief: string, writer: 'analyst' | 'planner'): void;
  writeCard(card: CardRecord, history: CardHistoryEntry | null): void;
  deleteCard(cardId: string): void;
  openRecord(cardId: string, filename: string): RecordProjection;
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection;
  closeRecord(cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number): RecordProjection;
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection;
}

export interface ProjectCardRecordWriter {
  request<T>(operation: (session: ProjectMutationSession) => T): T;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse JSON at '${path}': ${(error as Error).message}`);
  }
}

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`Bootstrap entry is not a directory: '${path}'.`);
}

function assertRecursivelyEmpty(path: string): void {
  assertDirectory(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bootstrap layout contains a symlink: '${childPath}'.`);
    if (!entry.isDirectory()) throw new Error(`Bootstrap generated directory is not empty: '${childPath}'.`);
    assertRecursivelyEmpty(childPath);
  }
}

function assertDefaultRuntimeState(path: string): void {
  const raw = readJson(path);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`Default runtime state envelope is invalid: '${path}'.`);
  const envelope = raw as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(',') !== 'data,version' || envelope.version !== 1) {
    throw new Error(`Default runtime state envelope is invalid: '${path}'.`);
  }
  const state = runtimeStateSchema.parse(envelope.data);
  if (
    state.status !== 'stopped' ||
    state.project_id !== 'project' ||
    state.active_card_run !== null ||
    state.last_tick_at !== null ||
    state.started_at !== state.updated_at
  ) {
    throw new Error(`Runtime state is not the exact bootstrap default: '${path}'.`);
  }
}

function assertOnlyKnownEntries(path: string, allowed: ReadonlySet<string>): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    if (!allowed.has(entry.name)) throw new Error(`Unknown bootstrap layout entry: '${childPath}'.`);
    if (entry.isSymbolicLink()) throw new Error(`Bootstrap layout contains a symlink: '${childPath}'.`);
  }
}

function assertDefaultFileDirectory(path: string, targetName: string): void {
  assertDirectory(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const childPath = join(path, entry.name);
    const target = durableReplacementTemporaryTargetBasename(entry.name);
    if (entry.name !== targetName && target !== targetName) throw new Error(`Unknown bootstrap layout entry: '${childPath}'.`);
    if (!entry.isFile()) throw new Error(`Bootstrap default-file entry is not a regular file: '${childPath}'.`);
  }
}

function verifyCardsRoot(cardsPath: string): void {
  assertDirectory(cardsPath);
  const entries = readdirSync(cardsPath, { withFileTypes: true });
  for (const entry of entries) {
    const namespacePath = join(cardsPath, entry.name);
    if (!entry.isDirectory() || entry.name !== 'project') {
      throw new Error(`Bootstrap cards root contains non-bootstrap evidence: '${namespacePath}'.`);
    }
    if (hasCanonicalCardArtifact(namespacePath)) {
      throw new Error(`Bootstrap is not eligible because a committed canonical card exists: '${namespacePath}'.`);
    }
    validateIncompleteCardNamespace(namespacePath, 'project');
  }
}

/** Strict read-only proof that bootstrap cannot overwrite established generated state. */
export function verifyBootstrapEligibleLayout(
  projectRoot: string,
  lifecycleLock: RuntimeLifecycleLockHandle,
): BootstrapEligibility {
  assertRuntimeLifecycleLock(lifecycleLock, projectRoot);
  const canonicalProjectRoot = realpathSync(projectRoot);
  const externalGeneratedRoot = join(canonicalProjectRoot, '.saivage-work');
  if (existsSync(externalGeneratedRoot)) throw new Error(`Obsolete generated work root blocks bootstrap: '${externalGeneratedRoot}'.`);
  const saivagePath = join(canonicalProjectRoot, '.saivage');
  if (!existsSync(saivagePath)) throw new Error(`Held runtime lock is missing its .saivage parent at '${saivagePath}'.`);
  assertDirectory(saivagePath);
  assertOnlyKnownEntries(saivagePath, new Set([...GENERATED_ROOTS, ...PRESERVED_SAIVAGE_ENTRIES]));

  const locksPath = join(saivagePath, 'locks');
  if (!existsSync(locksPath)) throw new Error(`Held runtime lock directory is missing: '${locksPath}'.`);
  assertDirectory(locksPath);
  assertOnlyKnownEntries(locksPath, new Set(['runtime.lock']));
  const runtimeLockPath = join(locksPath, 'runtime.lock');
  if (!existsSync(runtimeLockPath) || !lstatSync(runtimeLockPath).isFile()) {
    throw new Error(`Held runtime lock is not a regular file: '${runtimeLockPath}'.`);
  }

  const cardsPath = join(saivagePath, 'cards');
  if (existsSync(cardsPath)) verifyCardsRoot(cardsPath);
  for (const name of ['agents', 'work', 'stages']) {
    const path = join(saivagePath, name);
    if (existsSync(path)) assertRecursivelyEmpty(path);
  }

  const statePath = join(saivagePath, 'state');
  if (existsSync(statePath)) {
    assertDefaultFileDirectory(statePath, 'runtime.json');
    const runtimePath = join(statePath, 'runtime.json');
    if (existsSync(runtimePath)) {
      if (!lstatSync(runtimePath).isFile()) throw new Error(`Default runtime state is not a regular file: '${runtimePath}'.`);
      assertDefaultRuntimeState(runtimePath);
    }
  }

  const logsPath = join(saivagePath, 'logs');
  if (existsSync(logsPath)) {
    assertDefaultFileDirectory(logsPath, 'app.jsonl');
    const appLogPath = join(logsPath, 'app.jsonl');
    if (existsSync(appLogPath) && (!lstatSync(appLogPath).isFile() || readFileSync(appLogPath).byteLength !== 0)) {
      throw new Error(`Bootstrap app log is not an empty regular file: '${appLogPath}'.`);
    }
  }

  const proof = { canonicalProjectRoot } as BootstrapEligibility;
  issuedEligibility.add(proof);
  return Object.freeze(proof);
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    assertDirectory(path);
    return;
  }
  const parent = dirname(path);
  if (!existsSync(parent)) ensureDirectory(parent);
  publishDirectory(path);
}

function establishBootstrapDefaults(projectRoot: string): void {
  const saivagePath = join(projectRoot, '.saivage');
  for (const relative of [
    'cards',
    'agents',
    'agents/conversations',
    'agents/runtime',
    'agents/runtime/actors',
    'agents/runtime/actors/llm',
    'state',
    'logs',
    'work',
    'work/cards',
    'work/processes',
    'work/tmp',
    'work/tmp/stash',
    'stages',
  ]) ensureDirectory(join(saivagePath, relative));

  const runtimePath = join(saivagePath, 'state', 'runtime.json');
  cleanupDurableReplacementTemporaries(dirname(runtimePath), ['runtime.json']);
  if (!existsSync(runtimePath)) {
    const now = new Date().toISOString();
    const data = runtimeStateSchema.parse({
      status: 'stopped', project_id: 'project', pid: process.pid, started_at: now,
      active_card_run: null, updated_at: now, last_tick_at: null,
    });
    durablyReplaceFile(runtimePath, Buffer.from(`${JSON.stringify({ version: 1, data }, null, 2)}\n`));
  }
  const appLogPath = join(saivagePath, 'logs', 'app.jsonl');
  cleanupDurableReplacementTemporaries(dirname(appLogPath), ['app.jsonl']);
  if (!existsSync(appLogPath)) durablyReplaceFile(appLogPath, new Uint8Array());
}

function validateBootstrapRootInput(input: NewProjectRootInput): void {
  const card = input.card;
  if (
    card.id !== 'project' || card.type !== 'project' || card.parent !== null || card.depth !== 0 ||
    card.position !== 0 || card.version_seq !== 1
  ) throw new Error('Bootstrap root input must be canonical project card version 1.');
  if (input.brief.trim().length === 0) throw new Error('Bootstrap root brief must be non-empty.');
  parseCardVersionArtifact({
    kind: 'card-version', format_version: 1, card_id: 'project', version: 1,
    committed_at: new Date().toISOString(), card, history: null,
  }, '<bootstrap-root-input>', { cardId: 'project', version: 1 });
}

function recordSlot(filename: string): AuthoredRecordSlot {
  const slot = basename(filename).replace(/\.(?:md|json)$/u, '');
  if (!authoredRecordSlotValues.includes(slot as AuthoredRecordSlot)) throw new Error(`Unsupported record slot '${filename}'.`);
  return slot as AuthoredRecordSlot;
}

function recordFilename(slot: AuthoredRecordSlot): string {
  return `${slot}.md`;
}

function recordUrl(cardId: string, slot: AuthoredRecordSlot, version: number): string {
  return `record:///${recordFilename(slot)}?card=${encodeURIComponent(cardId)}&v=${version}`;
}

function recordProjection(artifact: RecordVersionArtifact): RecordProjection {
  return Object.freeze({ cardId: artifact.card_id, filename: recordFilename(artifact.slot), slot: artifact.slot, version: artifact.version, recordUrl: recordUrl(artifact.card_id, artifact.slot, artifact.version), artifact });
}

class ProjectCardRecordWriterImpl implements ProjectCardRecordWriter, ProjectMutationSession {
  private cardGenerationDirty = false;
  constructor(private readonly authority: ProjectPersistenceAuthorityImpl) {}

  request<T>(operation: (session: ProjectMutationSession) => T): T {
    return this.authority.admitAuthorizedMutation(() => {
      try {
        const result = operation(this);
        if (this.cardGenerationDirty) { this.cardGenerationDirty = false; this.authority.refreshGeneration(); }
        return result;
      } catch (error) {
        if (this.cardGenerationDirty) { this.cardGenerationDirty = false; this.authority.fail(); }
        throw error;
      }
    });
  }

  createCard(card: CardRecord, briefContent: string, writer: 'analyst' | 'planner'): void {
    if (this.authority.hasCard(card.id)) throw new Error(`Cannot create card '${card.id}': already exists.`);
    if (card.version_seq !== 1) throw new Error(`New card '${card.id}' must have version_seq=1.`);
    const namespacePath = join(this.authority.projectRoot, '.saivage', 'cards', card.id);
    for (const relative of ['brief', 'brief/versions', 'card', 'card/versions']) ensureDirectory(join(namespacePath, relative));
    const committedAt = new Date().toISOString();
    const brief = parseRecordVersionArtifact({
      kind: 'record-version', format_version: 1, card_id: card.id, slot: 'brief', version: 1, state: 'closed',
      opened_at: committedAt, committed_at: committedAt, closed_at: committedAt, discarded_at: null, reason: null,
      writer, format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: briefContent,
    }, join(namespacePath, 'brief', 'versions', '1.json'), { cardId: card.id, slot: 'brief', version: 1 });
    const cardArtifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: 1, committed_at: committedAt, card, history: null }, join(namespacePath, 'card', 'versions', '1.json'), { cardId: card.id, version: 1 });
    this.replaceJson(join(namespacePath, 'brief', 'versions', '1.json'), brief);
    this.replaceJson(join(namespacePath, 'brief', 'index.json'), {
      kind: 'record-slot-index', format_version: 1, card_id: card.id, slot: 'brief', latest: 1, open: null,
      versions: { '1': { version: 1, state: 'closed', opened_at: committedAt, committed_at: committedAt, closed_at: committedAt, discarded_at: null, reason: null, writer, format: 'markdown', schema: brief.schema, card_version_seq: 1, size: Buffer.byteLength(briefContent) } },
    });
    this.replaceJson(join(namespacePath, 'card', 'versions', '1.json'), cardArtifact);
    this.cardGenerationDirty = true;
  }

  createBootstrapRoot(input: NewProjectRootInput): void {
    validateBootstrapRootInput(input);
    this.createCard(input.card, input.brief, input.card.created_by === 'planner' ? 'planner' : 'analyst');
    this.cardGenerationDirty = false;
    this.authority.refreshGeneration();
  }

  writeCard(card: CardRecord, history: CardHistoryEntry | null): void {
    const current = this.authority.generation.cards.get(card.id)?.current;
    if (!current || card.version_seq !== current.version + 1) throw new Error(`Card '${card.id}' expected version ${current ? current.version + 1 : 1}, got ${card.version_seq}.`);
    const path = join(this.authority.projectRoot, '.saivage', 'cards', card.id, 'card', 'versions', `${card.version_seq}.json`);
    const artifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: card.version_seq, committed_at: new Date().toISOString(), card, history }, path, { cardId: card.id, version: card.version_seq });
    this.replaceJson(path, artifact);
    this.cardGenerationDirty = true;
  }

  deleteCard(cardId: string): void {
    if (cardId === 'project') throw new Error('Cannot delete the project card.');
    const path = join(this.authority.projectRoot, '.saivage', 'cards', cardId);
    if (!this.authority.hasCard(cardId)) throw new Error(`Cannot delete missing card '${cardId}'.`);
    // Deletion durability remains the existing best-effort namespace removal contract.
    rmSync(path, { recursive: true });
    this.cardGenerationDirty = true;
  }

  openRecord(cardId: string, filename: string): RecordProjection {
    const slot = recordSlot(filename);
    const scanned = this.authority.generation.cards.get(cardId)?.records[slot];
    if (!scanned) throw new Error(`Card '${cardId}' not found.`);
    if (scanned.open) return recordProjection(scanned.open);
    const version = Math.max(0, ...scanned.artifacts.map((artifact) => artifact.version)) + 1;
    const path = this.recordArtifactPath(cardId, slot, version);
    ensureDirectory(dirname(path));
    const definition = slot === 'brief' ? 'record.brief.markdown.v1' : slot === 'status' ? 'record.status.markdown.v1' : 'record.review.markdown.v1';
    const artifact = parseRecordVersionArtifact({ kind: 'record-version', format_version: 1, card_id: cardId, slot, version, state: 'open', opened_at: new Date().toISOString(), committed_at: null, closed_at: null, discarded_at: null, reason: null, writer: null, format: 'markdown', schema: definition, card_version_seq: null, content: '' }, path, { cardId, slot, version });
    this.replaceJson(path, artifact);
    this.authority.refreshGeneration();
    return recordProjection(artifact);
  }

  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection {
    const artifact = this.requireOpen(cardId, recordSlot(filename), version);
    const next = parseRecordVersionArtifact({ ...artifact, content }, this.recordArtifactPath(cardId, artifact.slot, version), { cardId, slot: artifact.slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, artifact.slot, version), next);
    this.authority.refreshGeneration();
    return recordProjection(next);
  }

  closeRecord(cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number): RecordProjection {
    const slot = recordSlot(filename);
    const artifact = this.requireOpen(cardId, slot, version);
    const stamp = new Date().toISOString();
    const next = parseRecordVersionArtifact({ ...artifact, state: 'closed', committed_at: stamp, closed_at: stamp, writer, card_version_seq: cardVersionSeq }, this.recordArtifactPath(cardId, slot, version), { cardId, slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, slot, version), next);
    this.authority.refreshGeneration();
    return recordProjection(next);
  }

  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection {
    const slot = recordSlot(filename);
    const artifact = this.requireOpen(cardId, slot, version);
    const next = parseRecordVersionArtifact({ ...artifact, state: 'discarded', discarded_at: new Date().toISOString(), reason }, this.recordArtifactPath(cardId, slot, version), { cardId, slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, slot, version), next);
    this.authority.refreshGeneration();
    return recordProjection(next);
  }

  private requireOpen(cardId: string, slot: AuthoredRecordSlot, version: number): RecordVersionArtifact {
    const artifact = this.authority.generation.cards.get(cardId)?.records[slot].artifacts.find((candidate) => candidate.version === version);
    if (!artifact || artifact.state !== 'open') throw new Error(`Record '${cardId}/${slot}/${version}' is not open.`);
    return artifact;
  }

  private recordArtifactPath(cardId: string, slot: AuthoredRecordSlot, version: number): string {
    return join(this.authority.projectRoot, '.saivage', 'cards', cardId, slot, 'versions', `${version}.json`);
  }

  private replaceJson(path: string, value: unknown): void {
    try {
      durablyReplaceFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    } catch (error) {
      this.authority.fail();
      throw error;
    }
  }
}

class ProjectPersistenceAuthorityImpl implements ProjectPersistenceAuthority {
  private admissionState: PersistenceAuthorityState = 'closed';
  private currentGeneration: CanonicalStoreGeneration | null = null;
  private executing = false;
  readonly #writer: ProjectCardRecordWriterImpl;
  readonly reader: ProjectCardRecordReader;

  constructor(
    readonly projectRoot: string,
    private readonly lifecycleLock: RuntimeLifecycleLockHandle,
  ) {
    this.#writer = new ProjectCardRecordWriterImpl(this);
    this.reader = Object.freeze({
      generation: () => this.generation,
      record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => {
        const slot = recordSlot(filename);
        const scanned = this.generation.cards.get(cardId)?.records[slot];
        if (!scanned) throw new Error(`Card '${cardId}' not found.`);
        const artifact = version === 'latest' ? scanned.latest : version === 'open' ? scanned.open : scanned.artifacts.find((candidate) => candidate.version === version) ?? null;
        if (!artifact) throw new Error(`Record '${cardId}/${slot}/${String(version)}' does not exist.`);
        return recordProjection(artifact);
      },
    });
  }

  get writer(): ProjectCardRecordWriter { return this.#writer; }

  hasCard(cardId: string): boolean { return this.currentGeneration?.cards.has(cardId) ?? false; }

  get state(): PersistenceAuthorityState {
    return this.admissionState;
  }

  get generation(): CanonicalStoreGeneration {
    if (this.admissionState !== 'open' || this.currentGeneration === null) throw new Error('Persistence authority has no published generation.');
    return this.currentGeneration;
  }

  beginExclusive(): void {
    if (this.admissionState !== 'closed') throw new Error(`Cannot begin restabilization from '${this.admissionState}'.`);
    this.admissionState = 'exclusive-restabilization';
  }

  publish(generation: CanonicalStoreGeneration): void {
    if (this.admissionState !== 'exclusive-restabilization') throw new Error('Persistence authority is not exclusively restabilizing.');
    this.currentGeneration = generation;
    this.admissionState = 'open';
  }

  createBootstrapRoot(input: NewProjectRootInput): void {
    if (this.admissionState !== 'exclusive-restabilization') throw new Error('Bootstrap root creation requires exclusive authority ownership.');
    this.#writer.createBootstrapRoot(input);
  }

  refreshGeneration(): void {
    if (this.admissionState !== 'open' && this.admissionState !== 'exclusive-restabilization') throw new Error(`Cannot refresh persistence generation while '${this.admissionState}'.`);
    try {
      const observation = observeCanonicalProjectRoot(join(this.projectRoot, '.saivage', 'cards'));
      this.currentGeneration = restabilizeCanonicalStore(this.projectRoot, join(this.projectRoot, '.saivage', 'cards'), observation);
    } catch (error) { this.fail(); throw error; }
  }

  fail(): void {
    this.currentGeneration = null;
    this.admissionState = 'failed';
  }

  admitAuthorizedMutation<T>(operation: () => T): T {
    try {
      assertRuntimeLifecycleLock(this.lifecycleLock, this.projectRoot);
    } catch (error) {
      this.fail();
      throw error;
    }
    if (this.admissionState !== 'open') throw new Error(`Persistence mutation admission is '${this.admissionState}'.`);
    if (this.executing) throw new Error('Recursive persistence mutation admission is forbidden.');
    this.executing = true;
    try {
      return operation();
    } finally {
      this.executing = false;
    }
  }

  close(): void {
    if (this.executing) throw new Error('Cannot close persistence authority during a mutation.');
    if (this.admissionState !== 'failed') this.admissionState = 'closed';
    this.currentGeneration = null;
  }
}

export function openProjectPersistenceAuthority(input: {
  projectRoot: string;
  lifecycleLock: RuntimeLifecycleLockHandle;
  mode: PersistenceOpenMode;
}): ProjectPersistenceAuthority {
  assertRuntimeLifecycleLock(input.lifecycleLock, input.projectRoot);
  const projectRoot = realpathSync(input.projectRoot);
  const authority = new ProjectPersistenceAuthorityImpl(projectRoot, input.lifecycleLock);
  authority.beginExclusive();
  try {
    if (input.mode.kind === 'bootstrap') {
      validateBootstrapRootInput(input.mode.root);
      const eligibility = verifyBootstrapEligibleLayout(projectRoot, input.lifecycleLock);
      if (!issuedEligibility.has(eligibility) || eligibility.canonicalProjectRoot !== projectRoot) {
        throw new Error('Bootstrap eligibility proof is invalid or belongs to another project.');
      }
      establishBootstrapDefaults(projectRoot);
      const cardsPath = join(projectRoot, '.saivage', 'cards');
      const projectNamespace = join(cardsPath, 'project');
      if (existsSync(projectNamespace)) discardIncompleteCardNamespace(cardsPath, 'project');
      authority.createBootstrapRoot(input.mode.root);
    }
    const cardsPath = join(projectRoot, '.saivage', 'cards');
    const observation = observeCanonicalProjectRoot(cardsPath);
    const generation = restabilizeCanonicalStore(projectRoot, cardsPath, observation);
    authority.publish(generation);
    return authority;
  } catch (error) {
    authority.fail();
    if (error instanceof IndeterminatePublicationError) throw error;
    throw error;
  }
}
