// F13 r5 (Batch 2b deviation: sync API) — thin façade over CardStoreState
// (in-memory reads) and applyMutationSync (durable writes). Mutations are
// synchronous: in-process serialization is provided by the JS event loop (no
// awaits in the mutation body); cross-process serialization is provided by
// `withLockSync` inside `applyMutationSync`.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ProjectLock, appendSyncIdempotent, writeFileAtomic } from '../persistence/index.js';
import {
  cardHistoryEntrySchema,
  cardRecordSchema,
} from '../schemas/index.js';
import type {
  CardHistoryEntry,
  CardRecord,
  CardStatus,
  ControlActionSurface,
  NoteAuthor,
} from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { queueNotification } from '../notifications/index.js';
import { ProjectMutex } from './project-mutex.js';
import { repairSiblingPositions } from './position-repair.js';
import {
  CardStoreInvariantError,
  CardStoreState,
  ReorderSetMismatchError,
  cardHistoryPath,
  loadCardStoreState,
  readHistoryEntriesStrict,
} from './state.js';
import {
  applyMutationSync,
  applyMutationGroupSync,
  type ApplyMutationDeps,
  type ApplyMutationOp,
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
  buildNewCard,
  buildUpdatedCard,
  canTransition as canLifecycleTransition,
  collectChangedFields,
  isTerminalState,
  isTerminalType,
  normalizeNewCardId,
  prunePartialPatch,
  summarizeChangedFields,
  validateTransition as validateLifecycleTransition,
  type NewCardInput,
} from './lifecycle.js';

export interface CardMutationContext {
  actor: NoteAuthor;
  surface: ControlActionSurface;
  reason?: string;
}

export interface CardDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export type ReorderChildrenResult =
  | { ok: true; changed: number }
  | { ok: false; reason: 'reorder_set_mismatch'; missing: string[]; extra: string[] };

function now(): string {
  return new Date().toISOString();
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function generateId(type: string, existingIds: string[]): string {
  const prefix = type;
  const maxNum = existingIds
    .filter((id) => id.startsWith(prefix + '-'))
    .map((id) => {
      const num = parseInt(id.slice(prefix.length + 1), 10);
      return Number.isNaN(num) ? 0 : num;
    })
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}-${maxNum + 1}`;
}

function persistOp(next: CardRecord, ctx: CardMutationContext, changedFields: string[], changeSummary: string): ApplyMutationOp {
  return { kind: 'persist', next, historyKind: 'mutate', ctx, changedFields, changeSummary };
}

function archiveCardPath(projectRoot: string, id: string): string {
  return join(projectRoot, '.saivage', 'archive', 'cards', `${id}.json`);
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
  private readonly mutex: ProjectMutex;
  private readonly projectLock: ProjectLock;
  private state: CardStoreState;
  private readonly eventBus: EventBus;

  constructor(projectRoot: string, maxGoalDepth?: number, eventBus?: EventBus) {
    this.projectRoot = projectRoot;
    this.eventBus = eventBus ?? new EventBus();
    this.maxDepth = maxGoalDepth !== undefined && maxGoalDepth > 0 ? maxGoalDepth : 5;
    recoverCommitMarkers(projectRoot);
    this.mutex = new ProjectMutex();
    this.projectLock = new ProjectLock(join(projectRoot, '.saivage', 'project.lock'));
    repairSiblingPositions(projectRoot, this.maxDepth, this.mutex, this.projectLock, this.eventBus);
    this.state = loadCardStoreState(projectRoot, { maxDepth: this.maxDepth });
  }

  /**
   * Reload in-memory state from disk. Public read methods call this so that
   * a CardStore instance reflects writes made by other CardStore instances
   * pointing at the same project root.
   */
  private refreshState(): void {
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
      mutex: this.mutex,
      projectLock: this.projectLock,
      eventBus: this.eventBus,
    };
  }

  // ── Reads ────────────────────────────────────────────────────

  read(id: string): CardRecord | null {
    this.refreshState();
    const card = this.state.get(id);
    return card ? deepClone(card) : null;
  }

  list(): CardRecord[] {
    this.refreshState();
    return this.state.list().map((c) => deepClone(c));
  }

  listChildren(parentId: string): string[] {
    this.refreshState();
    return this.state.childrenOf(parentId);
  }

  getParent(id: string): string | null {
    this.refreshState();
    return this.state.parentOf(id);
  }

  getAncestors(id: string): string[] {
    this.refreshState();
    return this.state.ancestorsOf(id);
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    return this.getAncestors(id).includes(ancestorId);
  }

  getDescendantIds(id: string): string[] {
    this.refreshState();
    return this.state.descendantsOf(id);
  }

  detectCycles(id: string, newDependsOn: string[]): string[] {
    this.refreshState();
    return this.state.detectDependsOnCycle(id, newDependsOn);
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
    return canLifecycleTransition(from, to);
  }

  listCardHistory(id: string): CardHistoryEntry[] {
    const hp = cardHistoryPath(this.projectRoot, id);
    if (!existsSync(hp)) return [];
    return readHistoryEntriesStrict(hp).slice().reverse();
  }

  getCardAt(id: string, versionSeq: number): CardRecord {
    const current = this.read(id);
    if (!current) throw new Error(`Card '${id}' not found.`);
    if (versionSeq === current.version_seq) return current;
    const hp = cardHistoryPath(this.projectRoot, id);
    if (!existsSync(hp)) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    const entries = readHistoryEntriesStrict(hp);
    const entry = entries.find((e) => e.version_seq === versionSeq);
    if (!entry) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    return deepClone(entry.snapshot);
  }

  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    const from = this.getCardAt(id, fromSeq);
    const to = this.getCardAt(id, toSeq);
    const fields = new Set<keyof CardRecord>([
      ...(Object.keys(from) as Array<keyof CardRecord>),
      ...(Object.keys(to) as Array<keyof CardRecord>),
    ]);
    return Array.from(fields)
      .filter((f) => !valuesEqual(from[f], to[f]))
      .map((f) => ({ field: f as string, before: from[f], after: to[f] }));
  }

  // ── Mutations ────────────────────────────────────────────────

  create(input: NewCardInput): CardRecord {
    assertCanCreateCard(input);
    this.refreshState();
    const nowStamp = now();
    const allKnownIds = this.state.allKnownIds();
    const id = normalizeNewCardId(input.type, input.id, () => generateId(input.type, allKnownIds));

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
      const parentCard = this.read(input.parent);
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
    const parentForDepth = input.parent === null ? null : this.read(input.parent);
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
      const cycle = this.detectCycles(card.id, card.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const result = applyMutationSync(this.deps(), { kind: 'create', card: parsed.data });
    return deepClone(result.card!);
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.applyPatch(id, changes, 'update', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'update',
    });
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

  repairTerminalLifecycle(id: string, changes: Partial<CardRecord>): CardRecord {
    return this.applyPatch(id, changes, 'mutate', {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'terminal lifecycle repair',
    });
  }

  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult {
    this.refreshState();
    if (parentId !== PROJECT_CARD_ID && !this.state.get(parentId)) {
      throw new Error(`Parent card '${parentId}' does not exist.`);
    }
    let plan: { changed: string[]; nextPositions: Map<string, number> };
    try {
      plan = this.state.reorderChildren(parentId, orderedChildIds);
    } catch (err) {
      if (err instanceof ReorderSetMismatchError) return { ok: false, reason: 'reorder_set_mismatch', missing: err.missing, extra: err.extra };
      throw err;
    }
    if (plan.changed.length === 0) return { ok: true, changed: 0 };
    const stamp = now();
    const ops: ApplyMutationOp[] = [];
    for (const childId of plan.changed) {
      const child = this.state.get(childId);
      const position = plan.nextPositions.get(childId);
      if (!child || position === undefined) continue;
      const next = { ...child, position, updated_at: stamp, version_seq: child.version_seq + 1 };
      ops.push(persistOp(next, ctx, ['position'], 'reorder_child'));
    }
    applyMutationGroupSync(this.deps(), ops);
    return { ok: true, changed: ops.length };
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
    return this.applyPatch(id, { depends_on: newDependsOn }, 'depends', ctx);
  }

  setStatus(id: string, newStatus: CardStatus): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    this.validateTransition(card.status, newStatus);
    if (card.status === newStatus) return card;
    const lifecycle = (() => {
      switch (newStatus) {
        case 'drafting':
        case 'backlog':
        case 'active':
        case 'running':
        case 'changed':
        case 'cancelled':
          return { status: newStatus, result: null, error: null, completed_at: null } as CardRecord['lifecycle'];
        default:
          return card.lifecycle;
      }
    })();
    return this.applyPatch(id, { status: newStatus, lifecycle }, 'status', {
      actor: 'runtime',
      surface: 'runtime',
      reason: `status -> ${newStatus}`,
    });
  }

  delete(id: string): void {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (isTerminalState(card.status)) {
      throw new Error(
        `Cannot delete card '${id}' because it is in status '${card.status}'. Cards in ${card.status} status cannot be deleted.`,
      );
    }
    if (id === PROJECT_CARD_ID) throw new Error('Cannot delete the project card.');
    const children = this.state.childrenOf(id);
    if (children.length > 0) {
      throw new Error(
        `Cannot delete card '${id}' because it has ${children.length} child(ren). Delete children first.`,
      );
    }
    applyMutationSync(this.deps(), {
      kind: 'delete',
      cardId: id,
      historyKind: 'delete',
      finalSnapshot: card,
      ctx: { actor: 'runtime', surface: 'runtime', reason: 'delete' },
      changeSummary: 'card deleted',
    });
    this.compactSiblingPositions(card.parent, { actor: 'runtime', surface: 'runtime', reason: 'delete position compaction' });
  }

  archiveAndDeleteSubtree(ids: string[]): void {
    const idSet = new Set(ids);
    const cards = ids.map((id) => {
      const c = this.read(id);
      if (!c) throw new Error(`Card '${id}' not found.`);
      return c;
    });
    for (const card of cards) {
      for (const childId of this.state.childrenOf(card.id)) {
        if (!idSet.has(childId)) {
          throw new Error(
            `Card '${card.id}' has child '${childId}' outside the requested delete set.`,
          );
        }
      }
      const archivePath = archiveCardPath(this.projectRoot, card.id);
      if (existsSync(archivePath)) throw new Error(`Archive already exists for card '${card.id}'.`);
    }
    const archiveDir = join(this.projectRoot, '.saivage', 'archive', 'cards');
    mkdirSync(archiveDir, { recursive: true });
    for (const card of cards) {
      const historyFile = cardHistoryPath(this.projectRoot, card.id);
      const archivePayload = {
        archived_at: now(),
        card,
        children: this.state.childrenOf(card.id),
        history: existsSync(historyFile) ? readFileSync(historyFile, 'utf-8') : '',
        result: card.lifecycle.result,
        evidence_refs: { artifacts: card.artifacts, attachments: card.attachments },
      };
      writeFileAtomic(archiveCardPath(this.projectRoot, card.id), JSON.stringify(archivePayload, null, 2) + '\n');
    }
    const sorted = [...cards].sort((a, b) => b.depth - a.depth);
    const ops: ApplyMutationOp[] = sorted.map((card) => ({
      kind: 'delete',
      cardId: card.id,
      historyKind: 'archive',
      finalSnapshot: card,
      ctx: { actor: 'runtime', surface: 'runtime', reason: 'archive subtree' },
      changeSummary: 'card archived',
    }));
    applyMutationGroupSync(this.deps(), ops);
    for (const parent of new Set(cards.map((card) => card.parent))) this.compactSiblingPositions(parent, { actor: 'runtime', surface: 'runtime', reason: 'archive position compaction' });
  }

  // ── Internals ───────────────────────────────────────────────


  private compactSiblingPositions(parentId: string | null, ctx: CardMutationContext): void {
    if (parentId === null) return;
    const childIds = this.state.childrenOf(parentId);
    const ops: ApplyMutationOp[] = [];
    const stamp = now();
    childIds.forEach((childId, index) => {
      const child = this.state.get(childId);
      if (!child || child.position === index) return;
      ops.push(persistOp({ ...child, position: index, updated_at: stamp, version_seq: child.version_seq + 1 }, ctx, ['position'], 'compact_child_positions'));
    });
    applyMutationGroupSync(this.deps(), ops);
  }


  private applyPatch(
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate' | 'depends',
    ctx: CardMutationContext,
  ): CardRecord {
    const existing = this.read(id);
    if (!existing) throw new Error(`Card '${id}' not found.`);
    const realChanges = prunePartialPatch(existing, changes);
    if (Object.keys(realChanges).length === 0) return existing;
    const stamp = now();
    const candidate = buildUpdatedCard(existing, realChanges, stamp, {
      childCount: this.state.childrenOf(existing.id).length,
    }, ctx);
    if (realChanges.depends_on !== undefined) {
      const cycle = this.detectCycles(existing.id, candidate.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const parsed = cardRecordSchema.safeParse(candidate);
    if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
    const changedFields = collectChangedFields(existing, candidate, realChanges);
    const result = applyMutationSync(this.deps(), {
      kind: 'persist',
      next: parsed.data,
      historyKind,
      ctx,
      changedFields,
      changeSummary: summarizeChangedFields(changedFields),
    });
    const persisted = deepClone(result.card!);
    try {
      queueNotification(this.projectRoot, { kind: 'card', cardId: persisted.id }, 'card_changed', `${persisted.id} updated (${changedFields.join(', ')}) at v${persisted.version_seq}`, { actor: ctx.actor, surface: ctx.surface });
    } catch {
      // Notification enqueue is best-effort; never break the mutation.
    }
    return persisted;
  }

  // ── Test helpers ────────────────────────────────────────────

  resetHistoryForTests(id: string): void {
    const hp = cardHistoryPath(this.projectRoot, id);
    if (existsSync(hp)) rmSync(hp, { force: true });
  }
}

export { CardStoreInvariantError } from './state.js';
export const validateHistoryEntry = (entry: unknown) => cardHistoryEntrySchema.parse(entry);
export function loadCardHistoryEntries(projectRoot: string, id: string): CardHistoryEntry[] {
  const hp = cardHistoryPath(projectRoot, id);
  if (!existsSync(hp)) return [];
  return readHistoryEntriesStrict(hp);
}
