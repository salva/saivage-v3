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

export type { CardMutationContext };

export type { CardDiffEntry } from './history-reader.js';

export type { ReorderChildrenResult } from './hierarchy-commands.js';

export class CardStore {
  readonly maxDepth: number;
  readonly projectRoot: string;
  private readonly persistenceReader: ProjectCardRecordReader;
  private readonly persistenceWriter: ProjectCardRecordWriter;
  private activeMutationSession: ProjectMutationSession | null = null;
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
      notificationStore: this,
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

  invalidate(): void {
    this.state = this.stateFromGeneration();
  }

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void {
    this.patchService.setNotifyCard(notifyCard);
  }

  get recordReader(): ProjectCardRecordReader { return this.persistenceReader; }

  readRecord(cardId: string, filename: string, version: number | 'latest' | 'open' = 'latest'): RecordProjection {
    return this.persistenceReader.record(cardId, filename, version);
  }

  openRecord(cardId: string, filename: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.openRecord(cardId, filename) : this.persistenceWriter.request((writer) => writer.openRecord(cardId, filename));
  }

  editRecord(cardId: string, filename: string, version: number, content: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.editRecord(cardId, filename, version, content) : this.persistenceWriter.request((writer) => writer.editRecord(cardId, filename, version, content));
  }

  closeRecord(cardId: string, filename: string, version: number, writerRole: import('../schemas/index.js').AgentRole, cardVersionSeq: number): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.closeRecord(cardId, filename, version, writerRole, cardVersionSeq) : this.persistenceWriter.request((writer) => writer.closeRecord(cardId, filename, version, writerRole, cardVersionSeq));
  }

  discardRecord(cardId: string, filename: string, version: number, reason: string): RecordProjection {
    return this.activeMutationSession ? this.activeMutationSession.discardRecord(cardId, filename, version, reason) : this.persistenceWriter.request((writer) => writer.discardRecord(cardId, filename, version, reason));
  }

  runPersistenceRequest<T>(operation: () => T): T {
    if (this.activeMutationSession) throw new Error('Recursive card-store persistence request is forbidden.');
    return this.persistenceWriter.request((session) => {
      this.activeMutationSession = session;
      try { return operation(); } finally { this.activeMutationSession = null; }
    });
  }

  private deps(): ApplyMutationDeps {
    return {
      projectRoot: this.projectRoot,
      state: this.state,
      writer: { request: (operation) => this.activeMutationSession ? operation(this.activeMutationSession) : this.persistenceWriter.request(operation) },
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

  create(input: NewCardInput): CardRecord {
    const result = this.runPersistenceRequest(() => {
      this.state = this.stateFromGeneration();
      return this.lifecycleCommands.create(input);
    });
    this.readModelChanges.cardStateChanged();
    this.readModelChanges.runtimeChanged();
    return result;
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.lifecycleCommands.update(id, changes);
  }

  mutateCard(
    id: string,
    changes: Partial<CardRecord>,
    ctx: CardMutationContext,
  ): CardRecord {
    return this.lifecycleCommands.mutateCard(id, changes, ctx);
  }

  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.lifecycleCommands.commitTerminalLifecyclePatch(id, changes);
  }

  /**
   * Explicit runtime-owned lifecycle escape hatch for startup repair, terminal-result commits,
   * and operator/analyst correction flows that intentionally invalidate terminal state.
   */
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.lifecycleCommands.repairTerminalLifecycle(id, changes);
  }

  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult {
    const result = this.hierarchyCommands.reorderChildren(parentId, orderedChildIds, ctx);
    if (result.ok && result.changed > 0) this.readModelChanges.cardStateChanged();
    return result;
  }

  updateDependsOn(
    id: string,
    newDependsOn: string[],
    ctx: CardMutationContext = {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'dependency update',
    },
  ): CardRecord {
    return this.hierarchyCommands.updateDependsOn(id, newDependsOn, ctx);
  }

  setStatus(id: string, newStatus: CardStatus): CardRecord {
    return this.lifecycleCommands.setStatus(id, newStatus);
  }

  delete(id: string): void {
    this.archiveService.delete(id);
    this.readModelChanges.cardStateChanged();
    this.readModelChanges.runtimeChanged();
    this.readModelChanges.agentsChanged();
  }

  archiveAndDeleteSubtree(ids: string[]): void {
    this.archiveService.archiveAndDeleteSubtree(ids);
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
}

export { CardStoreInvariantError } from './errors.js';
