// In-memory card façade over the composition-owned canonical persistence authority.

import type {
  CardHistoryEntry,
  CardRecord,
  CardStatus,
} from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { CardStoreState } from './state.js';
import { CardReader } from './reader.js';
import { CardPatchService } from './card-patch-service.js';
import { CardHierarchyCommands, type ReorderChildrenResult } from './hierarchy-commands.js';
import { CardArchiveService } from './archive-service.js';
import { CardHistoryReader, type CardDiffEntry } from './history-reader.js';
import { CardLifecycleCommands } from './lifecycle-commands.js';
import type { ProjectCardRecordReader, ProjectCardRecordWriter, ProjectMutationSession, RecordProjection } from '../persistence/project-persistence-authority.js';
import type { ApplyMutationDeps } from './apply-mutation.js';
import {
  validateTransition as validateLifecycleTransition,
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { ReadModelChangeBroadcaster, type ReadModelChanges } from '../application/read-model-changes.js';
import { readDeletedCardIds } from '../persistence/deleted-card-ids.js';
import type { MutationAuthority } from '../application/mutation-authority.js';
import type { NotPromise } from '../application/mutation-lane.js';

export type { CardMutationContext };

export type { CardDiffEntry } from './history-reader.js';

export type { ReorderChildrenResult } from './hierarchy-commands.js';

export class CardStoreRepository {
  readonly maxDepth: number;
  readonly projectRoot: string;
  private readonly persistenceReader: ProjectCardRecordReader;
  private readonly persistenceWriter: ProjectCardRecordWriter;
  private activeMutationSession: ProjectMutationSession | null = null;
  private currentMutationAuthority: MutationAuthority | null = null;
  private state: CardStoreState;
  private readonly reader: CardReader;
  private readonly patchService: CardPatchService;
  private readonly hierarchyCommands: CardHierarchyCommands;
  private readonly archiveService: CardArchiveService;
  private readonly historyReader: CardHistoryReader;
  private readonly lifecycleCommands: CardLifecycleCommands;
  private readonly eventBus: EventBus;
  private readonly readModelChanges: ReadModelChanges;

  constructor(input: { projectRoot: string; reader: ProjectCardRecordReader; writer: ProjectCardRecordWriter; eventBus?: EventBus; readModelChanges?: ReadModelChanges }) {
    this.projectRoot = input.projectRoot;
    this.persistenceReader = input.reader;
    this.persistenceWriter = input.writer;
    this.eventBus = input.eventBus ?? new EventBus();
    this.readModelChanges = input.readModelChanges ?? new ReadModelChangeBroadcaster();
    this.maxDepth = 5;
    this.state = this.stateFromGeneration();
    this.reader = new CardReader(() => this.state);
    this.patchService = new CardPatchService({
      projectRoot: this.projectRoot,
      deps: () => this.deps(),
      read: (id) => this.read(id),
      childCount: (id) => this.state.childrenOf(id).length,
      detectCycles: (id, newDependsOn) => this.detectCycles(id, newDependsOn),
      notificationStore: this.authorize(() => this.requireMutationAuthority()),
    });
    this.hierarchyCommands = new CardHierarchyCommands({
      state: () => this.state,
      deps: () => this.deps(),
      applyPatch: (id, changes, historyKind, ctx) => this.applyPatch(id, changes, historyKind, ctx),
    });
    this.archiveService = new CardArchiveService({
      projectRoot: this.projectRoot,
      state: () => this.state,
      deps: () => this.deps(),
      read: (id) => this.read(id),
    });
    this.historyReader = new CardHistoryReader({
      persistenceReader: this.persistenceReader,
      read: (id) => this.read(id),
    });
    this.lifecycleCommands = new CardLifecycleCommands({
      projectRoot: this.projectRoot,
      maxDepth: this.maxDepth,
      state: () => this.state,
      setState: (state) => { this.state = state; },
      deps: () => this.deps(),
      read: (id) => this.read(id),
      validateTransition: (from, to) => this.validateTransition(from, to),
      applyPatch: (id, changes, historyKind, ctx) => this.applyPatch(id, changes, historyKind, ctx),
    });
  }

  authorize(authority: () => MutationAuthority): CardStore {
    return new CardStore(this, authority);
  }

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void {
    this.patchService.setNotifyCard(notifyCard);
  }

  get recordReader(): ProjectCardRecordReader { return this.persistenceReader; }

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection {
    return this.persistenceReader.record(cardId, filename, version);
  }

  openRecord(authority: MutationAuthority, cardId: string, filename: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.openRecord(cardId, filename) : this.persistenceWriter.request(authority, (writer) => writer.openRecord(cardId, filename));
  }

  editRecord(authority: MutationAuthority, cardId: string, filename: string, version: number, content: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.editRecord(cardId, filename, version, content) : this.persistenceWriter.request(authority, (writer) => writer.editRecord(cardId, filename, version, content));
  }

  closeRecord(authority: MutationAuthority, cardId: string, filename: string, version: number, writerRole: import('../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.closeRecord(cardId, filename, version, writerRole, cardVersionSeq) : this.persistenceWriter.request(authority, (writer) => writer.closeRecord(cardId, filename, version, writerRole, cardVersionSeq));
  }

  discardRecord(authority: MutationAuthority, cardId: string, filename: string, version: number, reason: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.discardRecord(cardId, filename, version, reason) : this.persistenceWriter.request(authority, (writer) => writer.discardRecord(cardId, filename, version, reason));
  }

  runPersistenceRequest<T>(authority: MutationAuthority, operation: () => NotPromise<T>): T {
    return this.persistenceWriter.request(authority, (session) => {
      this.activeMutationSession = session;
      this.currentMutationAuthority = authority;
      try { return operation(); } finally { this.activeMutationSession = null; this.currentMutationAuthority = null; }
    });
  }

  private deps(): ApplyMutationDeps {
    return {
      projectRoot: this.projectRoot,
      state: this.state,
      writer: { request: <T>(operation: (session: ProjectMutationSession) => T): T => this.activeMutationSession ? operation(this.activeMutationSession) : this.persistenceWriter.request<T>(this.requireMutationAuthority(), operation as (session: ProjectMutationSession) => NotPromise<T>) },
      eventBus: this.eventBus,
    };
  }

  // ── Reads ────────────────────────────────────────────────────

  read(id: string): CardRecord | null {
    return this.reader.read(id);
  }

  list(): CardRecord[] {
    return this.reader.list();
  }

  listChildren(parentId: string): string[] {
    return this.reader.listChildren(parentId);
  }

  getParent(id: string): string | null {
    return this.reader.getParent(id);
  }

  getAncestors(id: string): string[] {
    return this.reader.getAncestors(id);
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    return this.reader.isDescendantOf(id, ancestorId);
  }

  getDescendantIds(id: string): string[] {
    return this.reader.getDescendantIds(id);
  }

  detectCycles(id: string, newDependsOn: string[]): string[] {
    return this.reader.detectCycles(id, newDependsOn);
  }

  blocksFor(id: string): string[] {
    return this.reader.blocksFor(id);
  }

  validateTransition(from: CardStatus, to: CardStatus): void {
    validateLifecycleTransition(from, to);
  }

  /**
   * Non-throwing legality check for a single status step.
   * Returns `true` if `from === to` or if `to` is listed in `VALID_TRANSITIONS[from]`.
   * Used by runtime transition policy to gate `planner_set_status` and `cancel` actions
   * without raising.
   */
  canTransition(from: CardStatus, to: CardStatus): boolean {
    return this.reader.canTransition(from, to);
  }

  listCardHistory(id: string): CardHistoryEntry[] {
    return this.historyReader.listCardHistory(id);
  }

  getCardAt(id: string, versionSeq: number): CardRecord {
    return this.historyReader.getCardAt(id, versionSeq);
  }

  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    return this.historyReader.diffCard(id, fromSeq, toSeq);
  }

  // ── Mutations ────────────────────────────────────────────────

  create(authority: MutationAuthority, input: NewCardInput): CardRecord {
    const result = this.runPersistenceRequest(authority, () => {
      this.state = this.stateFromGeneration();
      return this.lifecycleCommands.create(input);
    });
    this.readModelChanges.cardStateChanged();
    this.readModelChanges.runtimeChanged();
    return result;
  }

  update(authority: MutationAuthority, id: string, changes: Partial<CardRecord>): CardRecord {
    return this.withMutationAuthority(authority, () => this.lifecycleCommands.update(id, changes));
  }

  mutateCard(
    authority: MutationAuthority,
    id: string,
    changes: Partial<CardRecord>,
    ctx: CardMutationContext,
  ): CardRecord {
    return this.withMutationAuthority(authority, () => this.lifecycleCommands.mutateCard(id, changes, ctx));
  }

  commitTerminalLifecyclePatch(authority: MutationAuthority, id: string, changes: Partial<CardRecord>): CardRecord {
    return this.withMutationAuthority(authority, () => this.lifecycleCommands.commitTerminalLifecyclePatch(id, changes));
  }

  /**
   * Explicit runtime-owned lifecycle escape hatch for startup repair, terminal-result commits,
   * and operator/analyst correction flows that intentionally invalidate terminal state.
   */
  repairTerminalLifecycle(authority: MutationAuthority, id: string, changes: Partial<CardRecord>): CardRecord {
    return this.withMutationAuthority(authority, () => this.lifecycleCommands.repairTerminalLifecycle(id, changes));
  }

  reorderChildren(authority: MutationAuthority, parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult {
    const result = this.withMutationAuthority(authority, () => this.hierarchyCommands.reorderChildren(parentId, orderedChildIds, ctx));
    if (result.ok && result.changed > 0) this.readModelChanges.cardStateChanged();
    return result;
  }

  updateDependsOn(
    authority: MutationAuthority,
    id: string,
    newDependsOn: string[],
    ctx: CardMutationContext = {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'dependency update',
    },
  ): CardRecord {
    return this.withMutationAuthority(authority, () => this.hierarchyCommands.updateDependsOn(id, newDependsOn, ctx));
  }

  setStatus(authority: MutationAuthority, id: string, newStatus: CardStatus): CardRecord {
    return this.withMutationAuthority(authority, () => this.lifecycleCommands.setStatus(id, newStatus));
  }

  delete(authority: MutationAuthority, id: string): void {
    this.withMutationAuthority(authority, () => this.archiveService.delete(id));
    this.readModelChanges.cardStateChanged();
    this.readModelChanges.runtimeChanged();
    this.readModelChanges.agentsChanged();
  }

  archiveAndDeleteSubtree(authority: MutationAuthority, ids: string[]): void {
    this.withMutationAuthority(authority, () => this.archiveService.archiveAndDeleteSubtree(ids));
    if (ids.length === 0) return;
    this.readModelChanges.cardStateChanged();
    this.readModelChanges.runtimeChanged();
    this.readModelChanges.agentsChanged();
  }


  // ── Internals ───────────────────────────────────────────────


  private applyPatch(
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate' | 'depends',
    ctx: CardMutationContext,
  ): CardRecord {
    const before = this.read(id);
    const result = this.patchService.applyPatch(id, changes, historyKind, ctx);
    if (!before || result.version_seq === before.version_seq) return result;
    this.readModelChanges.cardStateChanged();
    if (result.status !== before.status) {
      this.readModelChanges.runtimeChanged();
      this.readModelChanges.agentsChanged();
    } else if (result.type !== before.type) {
      this.readModelChanges.runtimeChanged();
    }
    return result;
  }

  private stateFromGeneration(): CardStoreState {
    const state = new CardStoreState(this.maxDepth);
    const cards = [...this.persistenceReader.generation().cards.values()].map((entry) => entry.current.card).sort((left, right) => left.depth - right.depth);
    for (const card of cards) state.upsert(card);
    for (const id of readDeletedCardIds(this.projectRoot)) state.addReservedId(id);
    return state;
  }

  private withMutationAuthority<T>(authority: MutationAuthority, operation: () => T): T {
    const previous = this.currentMutationAuthority;
    this.currentMutationAuthority = authority;
    try { return operation(); } finally { this.currentMutationAuthority = previous; }
  }

  private requireMutationAuthority(): MutationAuthority {
    if (this.currentMutationAuthority === null) throw new Error('Card mutation requires an authorized capability.');
    return this.currentMutationAuthority;
  }
}

/** Authority-bound card capability. Reads share repository state; every mutation obtains exact current authority at call time. */
export class CardStore {
  constructor(readonly repository: CardStoreRepository, private readonly authority: () => MutationAuthority) {}

  get projectRoot(): string { return this.repository.projectRoot; }
  get maxDepth(): number { return this.repository.maxDepth; }
  get recordReader(): ProjectCardRecordReader { return this.repository.recordReader; }
  currentMutationAuthority(): MutationAuthority { return this.authority(); }
  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void { this.repository.setNotifyCard(notifyCard); }
  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection { return this.repository.readRecord(cardId, filename, version); }
  openRecord(cardId: string, filename: string): RecordProjection { return this.repository.openRecord(this.authority(), cardId, filename); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return this.repository.editRecord(this.authority(), cardId, filename, version, content); }
  closeRecord(cardId: string, filename: string, version: number, role: import('../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection { return this.repository.closeRecord(this.authority(), cardId, filename, version, role, cardVersionSeq); }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return this.repository.discardRecord(this.authority(), cardId, filename, version, reason); }
  runPersistenceRequest<T>(operation: () => NotPromise<T>): T { return this.repository.runPersistenceRequest(this.authority(), operation); }
  read(id: string): CardRecord | null { return this.repository.read(id); }
  list(): CardRecord[] { return this.repository.list(); }
  listChildren(parentId: string): string[] { return this.repository.listChildren(parentId); }
  getParent(id: string): string | null { return this.repository.getParent(id); }
  getAncestors(id: string): string[] { return this.repository.getAncestors(id); }
  isDescendantOf(id: string, ancestorId: string): boolean { return this.repository.isDescendantOf(id, ancestorId); }
  getDescendantIds(id: string): string[] { return this.repository.getDescendantIds(id); }
  detectCycles(id: string, dependsOn: string[]): string[] { return this.repository.detectCycles(id, dependsOn); }
  blocksFor(id: string): string[] { return this.repository.blocksFor(id); }
  validateTransition(from: CardStatus, to: CardStatus): void { this.repository.validateTransition(from, to); }
  canTransition(from: CardStatus, to: CardStatus): boolean { return this.repository.canTransition(from, to); }
  listCardHistory(id: string): CardHistoryEntry[] { return this.repository.listCardHistory(id); }
  getCardAt(id: string, versionSeq: number): CardRecord { return this.repository.getCardAt(id, versionSeq); }
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] { return this.repository.diffCard(id, fromSeq, toSeq); }
  create(input: NewCardInput): CardRecord { return this.repository.create(this.authority(), input); }
  update(id: string, changes: Partial<CardRecord>): CardRecord { return this.repository.update(this.authority(), id, changes); }
  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord { return this.repository.mutateCard(this.authority(), id, changes, ctx); }
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord { return this.repository.commitTerminalLifecyclePatch(this.authority(), id, changes); }
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord { return this.repository.repairTerminalLifecycle(this.authority(), id, changes); }
  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult { return this.repository.reorderChildren(this.authority(), parentId, orderedChildIds, ctx); }
  updateDependsOn(id: string, dependsOn: string[], ctx?: CardMutationContext): CardRecord { return this.repository.updateDependsOn(this.authority(), id, dependsOn, ctx); }
  setStatus(id: string, status: CardStatus): CardRecord { return this.repository.setStatus(this.authority(), id, status); }
  delete(id: string): void { this.repository.delete(this.authority(), id); }
  archiveAndDeleteSubtree(ids: string[]): void { this.repository.archiveAndDeleteSubtree(this.authority(), ids); }
  records(): CardRecordStore { return new CardRecordStore(this.repository, this.authority); }
}

/** Authored-record capability for executors and reviewers; it deliberately has no card-tree mutator. */
export class CardRecordStore {
  readonly #repository: CardStoreRepository;
  readonly #authority: () => MutationAuthority;
  constructor(repository: CardStoreRepository, authority: () => MutationAuthority) { this.#repository = repository; this.#authority = authority; }
  get recordReader(): ProjectCardRecordReader { return this.#repository.recordReader; }
  read(id: string): CardRecord | null { return this.#repository.read(id); }
  getAncestors(id: string): string[] { return this.#repository.getAncestors(id); }
  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection { return this.#repository.readRecord(cardId, filename, version); }
  openRecord(cardId: string, filename: string): RecordProjection { return this.#repository.openRecord(this.#authority(), cardId, filename); }
  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection { return this.#repository.editRecord(this.#authority(), cardId, filename, version, content); }
  closeRecord(cardId: string, filename: string, version: number, role: import('../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection { return this.#repository.closeRecord(this.#authority(), cardId, filename, version, role, cardVersionSeq); }
  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection { return this.#repository.discardRecord(this.#authority(), cardId, filename, version, reason); }
  runPersistenceRequest<T>(operation: () => NotPromise<T>): T { return this.#repository.runPersistenceRequest(this.#authority(), operation); }
  listCardHistory(id: string): CardHistoryEntry[] { return this.#repository.listCardHistory(id); }
  getCardAt(id: string, versionSeq: number): CardRecord { return this.#repository.getCardAt(id, versionSeq); }
  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] { return this.#repository.diffCard(id, fromSeq, toSeq); }
}

export { CardStoreInvariantError } from './errors.js';
