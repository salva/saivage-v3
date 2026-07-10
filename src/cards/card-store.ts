// F13 r5 (Batch 2b deviation: sync API) — thin façade over CardStoreState
// (in-memory reads) and applyMutationSync (durable writes). Mutations are
// synchronous: in-process serialization is provided by the JS event loop (no
// awaits in the mutation body); cross-process serialization is provided by
// `withLockSync` inside `applyMutationSync`.

import {
  existsSync,
  rmSync,
} from 'node:fs';
import { ProjectLock } from '../persistence/index.js';
import type {
  CardHistoryEntry,
  CardRecord,
  CardStatus,
} from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { repairSiblingPositions } from './position-repair.js';
import { CardStoreInvariantError } from './errors.js';
import { CardStoreState } from './state.js';
import { CardReader } from './reader.js';
import { CardPatchService } from './card-patch-service.js';
import { CardHierarchyCommands, type ReorderChildrenResult } from './hierarchy-commands.js';
import { CardArchiveService } from './archive-service.js';
import { CardHistoryReader, type CardDiffEntry } from './history-reader.js';
import { CardLifecycleCommands } from './lifecycle-commands.js';
import { cardHistoryPath, loadCardStoreState } from '../persistence/card-loader.js';
import { projectMutationLockFile } from '../persistence/layout.js';
import {
  applyMutationSync,
  type ApplyMutationDeps,
} from './apply-mutation.js';
import {
  validateTransition as validateLifecycleTransition,
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

export type { CardMutationContext };

export type { CardDiffEntry } from './history-reader.js';

export type { ReorderChildrenResult } from './hierarchy-commands.js';

export class CardStore {
  readonly maxDepth: number;
  readonly projectRoot: string;
  private readonly projectLock: ProjectLock;
  private state: CardStoreState;
  private readonly reader: CardReader;
  private readonly patchService: CardPatchService;
  private readonly hierarchyCommands: CardHierarchyCommands;
  private readonly archiveService: CardArchiveService;
  private readonly historyReader: CardHistoryReader;
  private readonly lifecycleCommands: CardLifecycleCommands;
  private readonly eventBus: EventBus;

  constructor(projectRoot: string, eventBus?: EventBus) {
    this.projectRoot = projectRoot;
    this.eventBus = eventBus ?? new EventBus();
    this.maxDepth = 5;
    this.projectLock = new ProjectLock(projectMutationLockFile(projectRoot));
    repairSiblingPositions(projectRoot, this.maxDepth, this.projectLock, this.eventBus);
    this.state = loadCardStoreState(projectRoot, { maxDepth: this.maxDepth });
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
      projectRoot: this.projectRoot,
      read: (id) => this.read(id),
    });
    this.lifecycleCommands = new CardLifecycleCommands({
      projectRoot: this.projectRoot,
      maxDepth: this.maxDepth,
      projectLock: this.projectLock,
      state: () => this.state,
      setState: (state) => { this.state = state; },
      deps: () => this.deps(),
      read: (id) => this.read(id),
      validateTransition: (from, to) => this.validateTransition(from, to),
      applyPatch: (id, changes, historyKind, ctx) => this.applyPatch(id, changes, historyKind, ctx),
    });
  }

  invalidate(): void {
    this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });
  }

  setNotifyCard(notifyCard: ((cardId: string, notification: CardNotification) => NotifyCardResult) | undefined): void {
    this.patchService.setNotifyCard(notifyCard);
  }

  private deps(): ApplyMutationDeps {
    return {
      projectRoot: this.projectRoot,
      state: this.state,
      projectLock: this.projectLock,
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
    return this.lifecycleCommands.create(input);
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
    return this.hierarchyCommands.reorderChildren(parentId, orderedChildIds, ctx);
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
  }

  archiveAndDeleteSubtree(ids: string[]): void {
    this.archiveService.archiveAndDeleteSubtree(ids);
  }


  // ── Internals ───────────────────────────────────────────────


  private applyPatch(
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate' | 'depends',
    ctx: CardMutationContext,
  ): CardRecord {
    return this.patchService.applyPatch(id, changes, historyKind, ctx);
  }

  // ── Test helpers ────────────────────────────────────────────

  resetHistoryForTests(id: string): void {
    const hp = cardHistoryPath(this.projectRoot, id);
    if (existsSync(hp)) rmSync(hp, { force: true });
  }
}

export { CardStoreInvariantError } from './errors.js';
