// F13 r5 (Batch 2b deviation: sync API) — thin façade over CardStoreState
// (in-memory reads) and applyMutationSync (durable writes). Mutations are
// synchronous: in-process serialization is provided by the JS event loop (no
// awaits in the mutation body); cross-process serialization is provided by
// `withLockSync` inside `applyMutationSync`.

import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ProjectLock, appendSyncIdempotent } from '../persistence/index.js';
import {
  cardHistoryEntrySchema,
  cardRecordSchema,
} from '../schemas/index.js';
import type {
  CardHistoryEntry,
  CardRecord,
  CardStatus,
} from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { now } from '../utils/clock.js';
import { repairSiblingPositions } from './position-repair.js';
import { CardStoreInvariantError } from './errors.js';
import { CardStoreState } from './state.js';
import { CardReader } from './reader.js';
import { CardPatchService } from './card-patch-service.js';
import { CardHierarchyCommands, type ReorderChildrenResult } from './hierarchy-commands.js';
import { CardArchiveService } from './archive-service.js';
import { CardHistoryReader, type CardDiffEntry } from './history-reader.js';
import {
  EvidenceRefService,
  type AppendEvidenceRefsResult,
  type NewArtifactRef,
  type NewAttachmentRef,
} from './evidence-ref-service.js';
import { cardHistoryPath, loadCardStoreState, readHistoryEntriesStrict } from '../persistence/card-loader.js';
import {
  applyMutationWithOwnedLockSync,
  applyMutationSync,
  type ApplyMutationDeps,
} from './apply-mutation.js';
import {
  commitMarkerDir,
  isGroupMarkerFile,
  listCommitMarkerFiles,
  readCommitMarkerFile,
  unlinkCommitMarker,
  unlinkGroupCommitMarker,
  type CommitMarker,
  type GroupCommitMarker,
} from './commit-marker.js';
import { PROJECT_CARD_ID } from './project-card.js';
import {
  assertCanCreateCard,
  buildSetStatusLifecycle,
  buildNewCard,
  isTerminalState,
  isTerminalType,
  newCardId,
  validateTransition as validateLifecycleTransition,
  type CardMutationContext,
  type NewCardInput,
} from './lifecycle.js';

export type { CardMutationContext };

export type { CardDiffEntry } from './history-reader.js';

export type { ReorderChildrenResult } from './hierarchy-commands.js';

export type { AppendEvidenceRefsResult, NewArtifactRef, NewAttachmentRef } from './evidence-ref-service.js';

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function generateId(existingIds: string[]): string {
  const prefix = 'card';
  const maxNum = existingIds
    .filter((id) => id.startsWith(prefix + '-'))
    .map((id) => {
      const num = parseInt(id.slice(prefix.length + 1), 10);
      return Number.isNaN(num) ? 0 : num;
    })
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}-${maxNum + 1}`;
}

function recoverCommitMarkers(projectRoot: string): void {
  const files = listCommitMarkerFiles(projectRoot);
  if (files.length === 0) return;
  for (const filePath of files) {
    if (isGroupMarkerFile(filePath)) continue;
    let parsed: CommitMarker;
    try {
      parsed = readCommitMarkerFile(filePath) as CommitMarker;
    } catch (err) {
      throw new CardStoreInvariantError(
        `Commit marker '${filePath}' is unparseable: ${(err as Error).message}`,
      );
    }
    if (parsed.by_id.kind === 'rename') {
      if (existsSync(parsed.by_id.tmp_path)) {
        try {
          renameSync(parsed.by_id.tmp_path, parsed.by_id.final_path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    } else if (parsed.by_id.kind === 'unlink') {
      if (existsSync(parsed.by_id.unlink_path)) {
        try {
          unlinkSync(parsed.by_id.unlink_path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
    if (parsed.history !== null) {
      appendSyncIdempotent(
        parsed.history.jsonl_path,
        parsed.history.entry as unknown as { entry_id: string } & Record<string, unknown>,
      );
    }
    unlinkCommitMarker(projectRoot, parsed.token);
  }
  for (const filePath of listCommitMarkerFiles(projectRoot)) {
    if (!isGroupMarkerFile(filePath)) continue;
    const parsed = readCommitMarkerFile(filePath) as GroupCommitMarker;
    unlinkGroupCommitMarker(projectRoot, parsed.group_token);
  }
  const byIdDir = join(projectRoot, '.saivage', 'cards', 'by-id');
  if (existsSync(byIdDir)) {
    for (const entry of readdirSync(byIdDir)) {
      if (/\.tmp\.[0-9a-f]+$/.test(entry)) {
        try {
          unlinkSync(join(byIdDir, entry));
        } catch {
          // best effort
        }
      }
    }
  }
  void commitMarkerDir(projectRoot);
}

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
  private readonly evidenceRefService: EvidenceRefService;
  private readonly eventBus: EventBus;

  constructor(projectRoot: string, maxGoalDepth?: number, eventBus?: EventBus) {
    this.projectRoot = projectRoot;
    this.eventBus = eventBus ?? new EventBus();
    this.maxDepth = maxGoalDepth !== undefined && maxGoalDepth > 0 ? maxGoalDepth : 5;
    recoverCommitMarkers(projectRoot);
    this.projectLock = new ProjectLock(join(projectRoot, '.saivage', 'project.lock'));
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
    this.evidenceRefService = new EvidenceRefService({
      projectRoot: this.projectRoot,
      projectLock: this.projectLock,
      deps: () => this.deps(),
      read: (id) => this.read(id),
      get: (id) => this.state.get(id) ?? null,
      childCount: (id) => this.state.childrenOf(id).length,
      emitHistoryAppended: (event) => this.eventBus.emit('card_history_appended', event),
      notificationStore: this,
    });
  }

  invalidate(): void {
    this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });
  }

  static async open(
    projectRoot: string,
    eventBus?: EventBus,
    maxGoalDepth?: number,
  ): Promise<CardStore> {
    return new CardStore(projectRoot, maxGoalDepth, eventBus);
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
   * Used by `RuntimeStateMachine` to gate `planner_set_status` and `cancel` actions
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
    assertCanCreateCard(input);
    let created: CardRecord | null = null;
    this.projectLock.withLockSync((handle) => {
      this.projectLock.assertOwns(handle);
      this.state = loadCardStoreState(this.projectRoot, { maxDepth: this.maxDepth });
      const nowStamp = now();
      const id = newCardId(input.type, () => generateId(this.state.allKnownIds()));

      if (this.state.isReservedId(id)) {
        throw new Error(
          `Cannot create card '${id}': card ids are durable and this id is already reserved by history or archive state.`,
        );
      }

      if (input.type === 'project') {
        const existing = this.state.list().find((c) => c.type === 'project');
        if (existing) {
          throw new Error(
            `Cannot create duplicate project card. A project card already exists with id '${existing.id}'.`,
          );
        }
      }
      if (input.parent !== null) {
        const parentCard = this.state.get(input.parent);
        if (!parentCard) {
          if (input.parent !== PROJECT_CARD_ID) throw new Error(`Parent card '${input.parent}' does not exist.`);
        } else {
          if (isTerminalType(parentCard.type)) {
            throw new Error(
              `Cannot create child under terminal card '${input.parent}' (type: ${parentCard.type}). Terminal cards cannot have children.`,
            );
          }
          if (isTerminalState(parentCard.status)) {
            throw new Error(
              `Cannot create child under card '${input.parent}' because it is in status '${parentCard.status}'. Children cannot be created under cards in ${parentCard.status} status.`,
            );
          }
        }
      }
      const parentForDepth = input.parent === null ? null : this.state.get(input.parent);
      const depth = input.parent === null ? 0 : parentForDepth ? parentForDepth.depth + 1 : 1;
      const position = input.parent === null ? 0 : this.state.childrenOf(input.parent).length;
      if (depth > this.maxDepth) {
        throw new Error(
          `Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}. Reduce nesting depth by reorganizing the card hierarchy.`,
        );
      }
      const card = buildNewCard({ input, id, depth, position, timestamp: nowStamp });
      const parsed = cardRecordSchema.safeParse(card);
      if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
      if (card.depends_on.length > 0) {
        const cycle = this.state.detectDependsOnCycle(card.id, card.depends_on);
        if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
      const result = applyMutationWithOwnedLockSync(this.deps(), handle, { kind: 'create', card: parsed.data });
      created = result.card;
    });
    return deepClone(created!);
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.applyPatch(id, changes, 'update', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'update',
    });
  }

  appendEvidenceRefs(
    id: string,
    refs: { artifacts?: NewArtifactRef[]; attachments?: NewAttachmentRef[] },
    ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'append evidence refs' },
  ): AppendEvidenceRefsResult {
    return this.evidenceRefService.appendEvidenceRefs(id, refs, ctx);
  }

  mutateCard(
    id: string,
    changes: Partial<CardRecord>,
    ctx: CardMutationContext,
  ): CardRecord {
    return this.applyPatch(id, changes, 'mutate', ctx);
  }

  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.applyPatch(id, changes, 'mutate', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'terminal lifecycle commit',
    });
  }

  /**
   * Explicit runtime-owned lifecycle escape hatch for startup repair, terminal-result commits,
   * and operator/analyst correction flows that intentionally invalidate terminal state.
   */
  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.applyPatch(id, changes, 'mutate', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'terminal lifecycle repair',
    });
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
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (newStatus === 'done' || newStatus === 'failed') {
      throw new Error(
        `setStatus does not support '${newStatus}'; use the terminal lifecycle commit path instead.`,
      );
    }
    this.validateTransition(card.status, newStatus);
    if (card.status === newStatus) return card;
    const stamp = now();
    const lifecycle = buildSetStatusLifecycle(card, newStatus, stamp);
    return this.applyPatch(id, { status: newStatus, lifecycle }, 'status', {
      actor: 'runtime',
      surface: 'runtime',
      reason: `status -> ${newStatus}`,
    });
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
export const validateHistoryEntry = (entry: unknown) => cardHistoryEntrySchema.parse(entry);
export function loadCardHistoryEntries(projectRoot: string, id: string): CardHistoryEntry[] {
  const hp = cardHistoryPath(projectRoot, id);
  if (!existsSync(hp)) return [];
  return readHistoryEntriesStrict(hp);
}
