import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { AgentRole, CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { runtimeStateSchema } from '../schemas/index.js';
import type { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import { parseCardVersionArtifact } from './canonical-card-artifacts.js';
import { authoredRecordSlotValues, parseRecordVersionArtifact, type AuthoredRecordSlot, type RecordVersionArtifact } from './canonical-record-artifacts.js';
import {
  discardIncompleteCardNamespace,
  hasCanonicalCardArtifact,
  isCanonicalCardId,
  loadProjectStore,
  parseCardTombstone,
  validateIncompleteCardNamespace,
  type CardTombstone,
  type ProjectStoreModel,
  type ScannedRecordSlot,
  type ScannedCard,
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

export interface NewProjectRootInput {
  readonly card: CardRecord;
  readonly brief: string;
}

export type PersistenceOpenMode =
  | { readonly kind: 'normal' }
  | { readonly kind: 'bootstrap'; readonly root: NewProjectRootInput };

function canonicalRootPublicationState(projectRoot: string): 'unpublished' | 'published-or-malformed' {
  const pathSegments = ['.saivage', 'cards', 'project', 'card', 'versions'];
  let current = projectRoot;
  for (const segment of pathSegments) {
    current = join(current, segment);
    if (!existsSync(current)) return 'unpublished';
    if (!lstatSync(current).isDirectory()) return 'published-or-malformed';
  }
  const entries = readdirSync(current, { withFileTypes: true });
  if (entries.length === 0) return 'unpublished';
  for (const entry of entries) {
    if (!entry.isFile()) return 'published-or-malformed';
    const temporaryTarget = durableReplacementTemporaryTargetBasename(entry.name);
    if (temporaryTarget === null || !/^\d+\.json$/u.test(temporaryTarget)) return 'published-or-malformed';
  }
  return 'unpublished';
}

/** Read-only startup classifier for commands that are explicitly allowed to bootstrap. */
export function classifyPersistenceOpenMode(
  projectRoot: string,
  root: NewProjectRootInput,
): PersistenceOpenMode {
  if (canonicalRootPublicationState(projectRoot) === 'published-or-malformed') return { kind: 'normal' };
  try {
    verifyBootstrapEligibleLayout(projectRoot);
    return { kind: 'bootstrap', root };
  } catch {
    return { kind: 'normal' };
  }
}

export interface ProjectStoreRepository {
  readonly projectRoot: string;
  readonly reader: ProjectCardRecordReader;
  readonly writer: ProjectCardRecordWriter;
  readonly activeCardIds: ReadonlySet<string>;
  readonly tombstonedCardIds: ReadonlySet<string>;
  readonly namespace: ProjectNamespaceReader;
}

export interface ProjectNamespaceReader {
  activeCardIds(): readonly string[];
  isActiveCardId(cardId: string): boolean;
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
  cards(): readonly CardRecord[];
  activeCardIds(): readonly string[];
  isActiveCardId(cardId: string): boolean;
  reservedCardIds(): ReadonlySet<string>;
  cardArtifacts(cardId: string): ScannedCard;
  record(cardId: string, filename: string, version?: number | 'latest' | 'open'): RecordProjection;
}

export interface ProjectCardRecordWriter {
  createCard(card: CardRecord, brief: string, writer: 'analyst' | 'planner'): void;
  writeCard(card: CardRecord, history: CardHistoryEntry | null): void;
  deleteCard(cardId: string, finalCard: CardRecord, deletionHistory: CardHistoryEntry): void;
  openRecord(cardId: string, filename: string): RecordProjection;
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection;
  closeRecord(cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number): RecordProjection;
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection;
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
): void {
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
    assertRecursivelyEmpty(logsPath);
  }

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

class ProjectCardRecordWriterImpl implements ProjectCardRecordWriter {
  constructor(private readonly repository: ProjectStoreRepositoryImpl) {}

  createCard(card: CardRecord, briefContent: string, writer: 'analyst' | 'planner'): void {
    this.repository.assertMutationHealthy();
    if (!isCanonicalCardId(card.id)) throw new Error(`Invalid card namespace identity '${card.id}'.`);
    if (this.repository.isReserved(card.id)) throw new Error(`Cannot create card '${card.id}': already exists or is reserved.`);
    if (card.version_seq !== 1) throw new Error(`New card '${card.id}' must have version_seq=1.`);
    const namespacePath = join(this.repository.projectRoot, '.saivage', 'cards', card.id);
    for (const relative of ['brief', 'brief/versions', 'card', 'card/versions']) ensureDirectory(join(namespacePath, relative));
    const committedAt = new Date().toISOString();
    const brief = parseRecordVersionArtifact({
      kind: 'record-version', format_version: 1, card_id: card.id, slot: 'brief', version: 1, state: 'closed',
      opened_at: committedAt, committed_at: committedAt, closed_at: committedAt, discarded_at: null, reason: null,
      writer, format: 'markdown', schema: 'record.brief.markdown.v1', card_version_seq: 1, content: briefContent,
    }, join(namespacePath, 'brief', 'versions', '1.json'), { cardId: card.id, slot: 'brief', version: 1 });
    const cardArtifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: 1, committed_at: committedAt, card, history: null }, join(namespacePath, 'card', 'versions', '1.json'), { cardId: card.id, version: 1 });
    this.replaceJson(join(namespacePath, 'brief', 'versions', '1.json'), brief, 'publish initial brief');
    this.replaceJson(join(namespacePath, 'card', 'versions', '1.json'), cardArtifact);
    this.repository.addCard(cardArtifact, brief);
  }

  createBootstrapRoot(input: NewProjectRootInput): void {
    validateBootstrapRootInput(input);
    this.createCard(input.card, input.brief, input.card.created_by === 'planner' ? 'planner' : 'analyst');
  }

  writeCard(card: CardRecord, history: CardHistoryEntry | null): void {
    this.repository.assertMutationHealthy();
    const current = this.repository.card(card.id)?.current;
    if (!current || card.version_seq !== current.version + 1) throw new Error(`Card '${card.id}' expected version ${current ? current.version + 1 : 1}, got ${card.version_seq}.`);
    const path = join(this.repository.projectRoot, '.saivage', 'cards', card.id, 'card', 'versions', `${card.version_seq}.json`);
    const artifact = parseCardVersionArtifact({ kind: 'card-version', format_version: 1, card_id: card.id, version: card.version_seq, committed_at: new Date().toISOString(), card, history }, path, { cardId: card.id, version: card.version_seq });
    this.replaceJson(path, artifact, 'publish card version');
    this.repository.appendCardArtifact(artifact);
  }

  deleteCard(cardId: string, finalCard: CardRecord, deletionHistory: CardHistoryEntry): void {
    this.repository.assertMutationHealthy();
    if (cardId === 'project') throw new Error('Cannot delete the project card.');
    if (!this.repository.card(cardId)) throw new Error(`Cannot delete missing card '${cardId}'.`);
    const path = join(this.repository.projectRoot, '.saivage', 'cards', cardId, 'tombstone.json');
    const tombstone: CardTombstone = parseCardTombstone({
      kind: 'card-tombstone', format_version: 1, card_id: cardId,
      deleted_at: deletionHistory.changed_at, final_card: finalCard, deletion_history: deletionHistory,
    }, path, cardId);
    this.replaceJson(path, tombstone, 'publish card tombstone');
    this.repository.markTombstoned(cardId);
  }

  openRecord(cardId: string, filename: string): RecordProjection {
    const slot = recordSlot(filename);
    this.repository.assertMutationHealthy();
    const scanned = this.repository.card(cardId)?.records[slot];
    if (!scanned) throw new Error(`Card '${cardId}' not found.`);
    if (scanned.open) return recordProjection(scanned.open);
    const version = Math.max(0, ...scanned.artifacts.map((artifact) => artifact.version)) + 1;
    const path = this.recordArtifactPath(cardId, slot, version);
    ensureDirectory(dirname(path));
    const definition = slot === 'brief' ? 'record.brief.markdown.v1' : slot === 'status' ? 'record.status.markdown.v1' : 'record.review.markdown.v1';
    const artifact = parseRecordVersionArtifact({ kind: 'record-version', format_version: 1, card_id: cardId, slot, version, state: 'open', opened_at: new Date().toISOString(), committed_at: null, closed_at: null, discarded_at: null, reason: null, writer: null, format: 'markdown', schema: definition, card_version_seq: null, content: '' }, path, { cardId, slot, version });
    this.replaceJson(path, artifact, 'open authored record');
    this.repository.appendRecordArtifact(cardId, slot, artifact);
    return recordProjection(artifact);
  }

  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection {
    const artifact = this.requireOpen(cardId, recordSlot(filename), version);
    const next = parseRecordVersionArtifact({ ...artifact, content }, this.recordArtifactPath(cardId, artifact.slot, version), { cardId, slot: artifact.slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, artifact.slot, version), next, 'edit authored record');
    this.repository.replaceRecordArtifact(cardId, artifact.slot, next);
    return recordProjection(next);
  }

  closeRecord(cardId: string, filename: string, version: number, writer: AgentRole, cardVersionSeq: number): RecordProjection {
    const slot = recordSlot(filename);
    const artifact = this.requireOpen(cardId, slot, version);
    const stamp = new Date().toISOString();
    const next = parseRecordVersionArtifact({ ...artifact, state: 'closed', committed_at: stamp, closed_at: stamp, writer, card_version_seq: cardVersionSeq }, this.recordArtifactPath(cardId, slot, version), { cardId, slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, slot, version), next, 'close authored record');
    this.repository.replaceRecordArtifact(cardId, slot, next);
    return recordProjection(next);
  }

  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection {
    const slot = recordSlot(filename);
    const artifact = this.requireOpen(cardId, slot, version);
    const next = parseRecordVersionArtifact({ ...artifact, state: 'discarded', discarded_at: new Date().toISOString(), reason }, this.recordArtifactPath(cardId, slot, version), { cardId, slot, version });
    this.replaceJson(this.recordArtifactPath(cardId, slot, version), next, 'discard authored record');
    this.repository.replaceRecordArtifact(cardId, slot, next);
    return recordProjection(next);
  }

  private requireOpen(cardId: string, slot: AuthoredRecordSlot, version: number): RecordVersionArtifact {
    this.repository.assertMutationHealthy();
    const artifact = this.repository.card(cardId)?.records[slot].artifacts.find((candidate) => candidate.version === version);
    if (!artifact || artifact.state !== 'open') throw new Error(`Record '${cardId}/${slot}/${version}' is not open.`);
    return artifact;
  }

  private recordArtifactPath(cardId: string, slot: AuthoredRecordSlot, version: number): string {
    return join(this.repository.projectRoot, '.saivage', 'cards', cardId, slot, 'versions', `${version}.json`);
  }

  private replaceJson(path: string, value: unknown, operation = 'publish card artifact'): void {
    try {
      durablyReplaceFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    } catch (error) {
      if (error instanceof IndeterminatePublicationError) this.repository.reportUncertain(path, operation, error);
      throw error;
    }
  }
}

class ProjectStoreRepositoryImpl implements ProjectStoreRepository {
  private model: ProjectStoreModel | null = null;
  readonly #writer: ProjectCardRecordWriterImpl;
  readonly reader: ProjectCardRecordReader;

  constructor(
    readonly projectRoot: string,
    private readonly health: ApplicationPersistenceHealth,
  ) {
    this.#writer = new ProjectCardRecordWriterImpl(this);
    this.reader = Object.freeze({
      cards: () => [...this.requireModel().cards.values()].map((entry) => entry.current.card),
      activeCardIds: () => [...this.requireModel().cards.keys()],
      isActiveCardId: (cardId: string) => this.requireModel().cards.has(cardId),
      reservedCardIds: () => new Set([...this.requireModel().cards.keys(), ...this.requireModel().tombstonedIds]),
      cardArtifacts: (cardId: string) => {
        const card = this.card(cardId);
        if (!card) throw new Error(`Card '${cardId}' not found.`);
        return card;
      },
      record: (cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest') => {
        const slot = recordSlot(filename);
        const scanned = this.card(cardId)?.records[slot];
        if (!scanned) throw new Error(`Card '${cardId}' not found.`);
        const artifact = version === 'latest' ? scanned.latest : version === 'open' ? scanned.open : scanned.artifacts.find((candidate) => candidate.version === version) ?? null;
        if (!artifact) throw new Error(`Record '${cardId}/${slot}/${String(version)}' does not exist.`);
        return recordProjection(artifact);
      },
    });
  }

  get writer(): ProjectCardRecordWriter { return this.#writer; }
  get namespace(): ProjectNamespaceReader { return this.reader; }
  get activeCardIds(): ReadonlySet<string> { return new Set(this.requireModel().cards.keys()); }
  get tombstonedCardIds(): ReadonlySet<string> { return new Set(this.requireModel().tombstonedIds); }

  card(cardId: string): ScannedCard | undefined { return this.requireModel().cards.get(cardId); }
  isReserved(cardId: string): boolean { const model = this.requireModel(); return model.cards.has(cardId) || model.tombstonedIds.has(cardId); }
  assertMutationHealthy(): void { this.health.assertMutationHealthy(); }
  reportUncertain(target: string, operation: string, error: unknown): never { return this.health.reportUncertainFailure({ target, operation, error }); }

  createBootstrapRoot(input: NewProjectRootInput): void {
    this.#writer.createBootstrapRoot(input);
  }

  beginBootstrap(): void {
    if (this.model !== null) throw new Error('Project store is already loaded.');
    this.model = { cards: new Map(), tombstonedIds: new Set() };
  }

  load(): void {
    this.model = loadProjectStore(join(this.projectRoot, '.saivage', 'cards'));
  }

  addCard(card: ReturnType<typeof parseCardVersionArtifact>, brief: RecordVersionArtifact): void {
    const model = this.requireModel();
    if (model.cards.has(card.card_id) || model.tombstonedIds.has(card.card_id)) throw new Error(`Card '${card.card_id}' is already reserved.`);
    const empty = (): ScannedRecordSlot => Object.freeze({ artifacts: Object.freeze([]), latest: null, open: null });
    model.cards.set(card.card_id, Object.freeze({
      artifacts: Object.freeze([card]),
      current: card,
      records: Object.freeze({
        brief: Object.freeze({ artifacts: Object.freeze([brief]), latest: brief, open: null }),
        status: empty(),
        review: empty(),
      }),
    }));
  }

  appendCardArtifact(artifact: ReturnType<typeof parseCardVersionArtifact>): void {
    const current = this.card(artifact.card_id);
    if (!current || artifact.version !== current.current.version + 1) throw new Error(`Cannot append card artifact '${artifact.card_id}/${artifact.version}'.`);
    this.requireModel().cards.set(artifact.card_id, Object.freeze({ ...current, artifacts: Object.freeze([...current.artifacts, artifact]), current: artifact }));
  }

  appendRecordArtifact(cardId: string, slot: AuthoredRecordSlot, artifact: RecordVersionArtifact): void {
    const card = this.card(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    const prior = card.records[slot];
    if (artifact.version !== prior.artifacts.length + 1) throw new Error(`Cannot append record artifact '${cardId}/${slot}/${artifact.version}'.`);
    this.setRecordSlot(cardId, slot, [...prior.artifacts, artifact]);
  }

  replaceRecordArtifact(cardId: string, slot: AuthoredRecordSlot, artifact: RecordVersionArtifact): void {
    const card = this.card(cardId);
    if (!card) throw new Error(`Card '${cardId}' not found.`);
    const prior = card.records[slot];
    const index = prior.artifacts.findIndex((candidate) => candidate.version === artifact.version);
    if (index === -1) throw new Error(`Record '${cardId}/${slot}/${artifact.version}' does not exist.`);
    const artifacts = [...prior.artifacts];
    artifacts[index] = artifact;
    this.setRecordSlot(cardId, slot, artifacts);
  }

  private setRecordSlot(cardId: string, slot: AuthoredRecordSlot, artifacts: readonly RecordVersionArtifact[]): void {
    const card = this.card(cardId)!;
    const open = artifacts.find((artifact) => artifact.state === 'open') ?? null;
    const latest = artifacts.filter((artifact) => artifact.state === 'closed').at(-1) ?? null;
    const nextSlot: ScannedRecordSlot = Object.freeze({ artifacts: Object.freeze([...artifacts]), latest, open });
    this.requireModel().cards.set(cardId, Object.freeze({ ...card, records: Object.freeze({ ...card.records, [slot]: nextSlot }) }));
  }

  markTombstoned(cardId: string): void {
    const model = this.requireModel();
    model.cards.delete(cardId);
    model.tombstonedIds.add(cardId);
  }

  private requireModel(): ProjectStoreModel {
    if (this.model === null) throw new Error('Project store has not loaded.');
    return this.model;
  }
}

export function createProjectStoreRepository(input: {
  projectRoot: string;
  persistenceHealth: ApplicationPersistenceHealth;
  mode: PersistenceOpenMode;
}): ProjectStoreRepository {
  const projectRoot = realpathSync(input.projectRoot);
  const repository = new ProjectStoreRepositoryImpl(projectRoot, input.persistenceHealth);
  if (input.mode.kind === 'bootstrap') {
    validateBootstrapRootInput(input.mode.root);
    verifyBootstrapEligibleLayout(projectRoot);
    establishBootstrapDefaults(projectRoot);
    const cardsPath = join(projectRoot, '.saivage', 'cards');
    const projectNamespace = join(cardsPath, 'project');
    if (existsSync(projectNamespace)) discardIncompleteCardNamespace(cardsPath, 'project');
    repository.beginBootstrap();
    repository.createBootstrapRoot(input.mode.root);
  }
  repository.load();
  return repository;
}
