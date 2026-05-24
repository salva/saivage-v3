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
  CardType,
  ControlActionSurface,
  NoteAuthor,
} from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { enqueueCardMutationNotifications } from '../notifications/index.js';
import { ProjectMutex } from './project-mutex.js';
import {
  CardStoreInvariantError,
  CardStoreState,
  cardHistoryPath,
  isTerminalState,
  isTerminalType,
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

const CRITICAL_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'parent',
  'depends_on',
  'depth',
  'id',
  'created_at',
]);

const ALWAYS_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'artifacts',
  'attachments',
  'result',
  'metrics',
  'error',
  'completed_at',
  'duration_ms',
  'started_at',
  'status_text',
  'status_text_updated_at',
  'status_text_author_session_id',
  'latest_self_report',
]);

const FULL_EDIT_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>(['drafting', 'backlog']);

const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'blocked', 'changed', 'cancelled', 'backlog', 'needs_verification'],
  blocked: ['backlog', 'running', 'changed', 'cancelled'],
  changed: ['backlog', 'active', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
  needs_verification: ['cancelled'],
};

const TRACKED_FIELDS = [
  'title',
  'description',
  'acceptance',
  'instructions_file',
  'type',
  'subtype',
  'parent',
  'tags',
  'priority',
  'urgency',
  'estimate',
  'depends_on',
  'blocks',
  'related',
  'assigned_to',
  'artifacts',
  'attachments',
] as const satisfies ReadonlyArray<keyof CardRecord>;

function now(): string {
  return new Date().toISOString();
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function summarizeChangedFields(changedFields: string[]): string {
  if (changedFields.length === 0) return 'card updated';
  return `${changedFields.join(', ')} updated`;
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

  constructor(projectRoot: string, maxGoalDepth?: number, _legacy?: unknown, eventBus?: EventBus) {
    this.projectRoot = projectRoot;
    this.eventBus = eventBus ?? new EventBus();
    this.maxDepth = maxGoalDepth !== undefined && maxGoalDepth > 0 ? maxGoalDepth : 5;
    recoverCommitMarkers(projectRoot);
    this.mutex = new ProjectMutex();
    this.projectLock = new ProjectLock(join(projectRoot, '.saivage', 'project.lock'));
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
    return new CardStore(projectRoot, maxGoalDepth, undefined, eventBus);
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
    if (from === to) return;
    const allowed = VALID_TRANSITIONS[from];
    if (allowed && allowed.includes(to)) return;
    throw new Error(
      `Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${allowed ? allowed.join(', ') : 'none'}.`,
    );
  }

  /**
   * Non-throwing legality check for a single status step.
   * Returns `true` if `from === to` or if `to` is listed in `VALID_TRANSITIONS[from]`.
   * Used by `RuntimeStateMachine` to gate `planner_set_status` and `cancel` actions
   * without raising.
   */
  canTransition(from: CardStatus, to: CardStatus): boolean {
    if (from === to) return true;
    const allowed = VALID_TRANSITIONS[from];
    return Boolean(allowed && allowed.includes(to));
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

  create(
    input: Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq'> & { id?: string },
  ): CardRecord {
    if ((input as { type: string }).type === 'plan') {
      throw new Error('Plan cards are no longer created. Planning state lives on goal cards.');
    }
    this.refreshState();
    const nowStamp = now();
    let id: string;
    if (input.id) id = input.id;
    else if (input.type === 'project') id = 'project';
    else id = generateId(input.type, this.state.list().map((c) => c.id));

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
      if (!parentCard) throw new Error(`Parent card '${input.parent}' does not exist.`);
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
    const depth = input.parent === null ? 0 : (this.read(input.parent)!.depth + 1);
    if (depth > this.maxDepth) {
      throw new Error(
        `Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}. Reduce nesting depth by reorganizing the card hierarchy.`,
      );
    }
    const card: CardRecord = {
      id,
      type: input.type,
      parent: input.parent,
      depth,
      title: input.title,
      description: input.description,
      status: input.status,
      subtype: input.subtype ?? null,
      instructions_file: input.instructions_file ?? null,
      tags: input.tags,
      priority: input.priority,
      urgency: input.urgency,
      created_by: input.created_by,
      created_at: nowStamp,
      updated_at: nowStamp,
      assigned_to: input.assigned_to ?? null,
      depends_on: input.depends_on,
      blocks: [],
      related: input.related,
      acceptance: input.acceptance,
      result: input.result ?? null,
      metrics: input.metrics ?? null,
      artifacts: input.artifacts,
      attachments: input.attachments,
      estimate: input.estimate ?? null,
      started_at: input.started_at ?? null,
      completed_at: input.completed_at ?? null,
      duration_ms: input.duration_ms ?? null,
      error: input.error ?? null,
      status_text: input.status_text ?? null,
      status_text_updated_at: input.status_text_updated_at ?? null,
      status_text_author_session_id: input.status_text_author_session_id ?? null,
      latest_self_report: input.latest_self_report ?? null,
      retries: input.retries,
      version_seq: 1,
    };
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
    return this.applyPatch(id, { status: newStatus }, 'status', {
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
    if (id === 'project') throw new Error('Cannot delete the project card.');
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
        notes_ref: join('.saivage', 'notes', `${card.id}.jsonl`),
        result: card.result,
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
  }

  // ── Internals ───────────────────────────────────────────────

  private prunePartialPatch(
    existing: CardRecord,
    changes: Partial<CardRecord>,
  ): Partial<CardRecord> {
    const pruned: Partial<CardRecord> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const current = (existing as unknown as Record<string, unknown>)[key];
      if (valuesEqual(current, value)) continue;
      (pruned as Record<string, unknown>)[key] = value;
    }
    return pruned;
  }

  private validateMutablePatch(existing: CardRecord, changes: Partial<CardRecord>): number {
    if ((changes as { type?: string }).type === 'plan') {
      throw new Error('Cannot change card type to plan: planning state lives on goal cards.');
    }
    if (isTerminalState(existing.status)) {
      for (const key of Object.keys(changes)) {
        if (key !== 'status' && !ALWAYS_ALLOWED_FIELDS.has(key)) {
          throw new Error(
            `Card '${existing.id}' is in status '${existing.status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`,
          );
        }
      }
    } else if (!FULL_EDIT_STATES.has(existing.status)) {
      for (const key of Object.keys(changes)) {
        if (CRITICAL_FIELDS.has(key)) {
          throw new Error(
            `Field '${key}' cannot be changed on a card in status '${existing.status}'. Cards in this state allow editing: status, title, description, priority, urgency, tags, and other non-structural fields.`,
          );
        }
      }
    }
    if (changes.type !== undefined && changes.type !== existing.type && isTerminalType(changes.type as CardType)) {
      const children = this.state.childrenOf(existing.id);
      if (children.length > 0) {
        throw new Error(
          `Cannot change type of card '${existing.id}' to '${changes.type}' because it has ${children.length} child(ren). Terminal cards cannot have children.`,
        );
      }
    }
    let newDepth = existing.depth;
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (changes.parent !== null) {
        const newParent = this.read(changes.parent);
        if (!newParent) throw new Error(`Parent card '${changes.parent}' does not exist.`);
        if (isTerminalType(newParent.type)) {
          throw new Error(
            `Cannot set parent to '${changes.parent}' because it is a terminal card (type: ${newParent.type}). Terminal cards cannot have children.`,
          );
        }
        if (this.state.descendantsOf(existing.id).includes(changes.parent)) {
          throw new Error(
            `Cannot set parent of card '${existing.id}' to descendant '${changes.parent}'.`,
          );
        }
        newDepth = (this.state.depthOf(newParent.id) ?? newParent.depth) + 1;
      } else {
        newDepth = 0;
      }
      if (newDepth > this.maxDepth) {
        throw new Error(
          `Cannot update card '${existing.id}' to depth ${newDepth}. Maximum allowed depth is ${this.maxDepth}. Choose a parent at a shallower level.`,
        );
      }
    }
    return newDepth;
  }

  private buildUpdatedCard(
    existing: CardRecord,
    changes: Partial<CardRecord>,
    stamp: string,
  ): CardRecord {
    const newDepth = this.validateMutablePatch(existing, changes);
    const newDependsOn =
      changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;
    return {
      ...existing,
      ...changes,
      id: existing.id,
      created_at: existing.created_at,
      created_by: existing.created_by,
      updated_at: stamp,
      depth: newDepth,
      depends_on: newDependsOn,
      blocks: existing.blocks,
      version_seq: existing.version_seq + 1,
    };
  }

  private applyPatch(
    id: string,
    changes: Partial<CardRecord>,
    historyKind: 'update' | 'status' | 'mutate' | 'depends',
    ctx: CardMutationContext,
  ): CardRecord {
    const existing = this.read(id);
    if (!existing) throw new Error(`Card '${id}' not found.`);
    const realChanges = this.prunePartialPatch(existing, changes);
    if (Object.keys(realChanges).length === 0) return existing;
    const stamp = now();
    const candidate = this.buildUpdatedCard(existing, realChanges, stamp);
    if (realChanges.depends_on !== undefined) {
      const cycle = this.detectCycles(existing.id, candidate.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const parsed = cardRecordSchema.safeParse(candidate);
    if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
    const changedFields: string[] = [];
    for (const f of TRACKED_FIELDS) {
      if (realChanges[f] !== undefined && !valuesEqual(existing[f], candidate[f])) {
        changedFields.push(f);
      }
    }
    for (const k of Object.keys(realChanges)) {
      if (!changedFields.includes(k)) changedFields.push(k);
    }
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
      enqueueCardMutationNotifications(this.projectRoot, persisted, changedFields, {
        actor: ctx.actor,
        surface: ctx.surface,
      });
    } catch {
      // Notification enqueue is best-effort; never break the mutation.
    }
    return persisted;
  }

  activateGoal(id: string): { goal: CardRecord } {
    const goal = this.read(id);
    if (!goal) throw new Error(`Goal '${id}' not found.`);
    if (goal.type !== 'project' && goal.type !== 'goal')
      throw new Error(`activateGoal requires a project or goal card, got type '${goal.type}'.`);
    const activeGoal =
      goal.status === 'active' || goal.status === 'running' ? goal : this.setStatus(id, 'active');
    const existingResult =
      activeGoal.result && typeof activeGoal.result === 'object'
        ? (activeGoal.result as Record<string, unknown>)
        : {};
    if (
      existingResult.planning &&
      typeof existingResult.planning === 'object'
    ) {
      return { goal: activeGoal };
    }
    return {
      goal: this.update(id, {
        result: {
          ...existingResult,
          planning: {
            status: 'continue',
            summary: null,
            blocked_reason: null,
            created_cards: [],
            updated_cards: [],
            updated_at: new Date().toISOString(),
          },
        } as CardRecord['result'],
      }),
    };
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
