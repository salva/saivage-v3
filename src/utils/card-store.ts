import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cardBlocksIndexSchema,
  cardChildrenIndexSchema,
  cardDependencyIndexSchema,
  cardHistoryEntrySchema,
  cardIndexSchema,
  cardRecordSchema,
} from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';
import type {
  CardBlocksIndex,
  CardChildrenIndex,
  CardDependencyIndex,
  CardHistoryEntry,
  CardIndex,
  CardRecord,
  CardStatus,
  CardType,
  ControlActionSurface,
  NoteAuthor,
} from '../schemas/types.js';
import { enqueueCardMutationNotifications } from './notification-triggers.js';
import { broadcastCardHistoryAppended } from '../server/websocket.js';

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

interface CardStoreTestHooks {
  beforeTrackedCardRename?: (card: CardRecord, historyEntry: CardHistoryEntry) => void;
}

const TERMINAL_TYPES: ReadonlySet<CardType> = new Set<CardType>([
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
]);

const TERMINAL_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'done',
  'failed',
  'cancelled',
]);

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
]);

const FULL_EDIT_STATES: ReadonlySet<CardStatus> = new Set<CardStatus>([
  'drafting',
  'backlog',
]);

const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  drafting: ['backlog', 'cancelled'],
  backlog: ['active', 'cancelled'],
  active: ['running', 'cancelled', 'backlog'],
  running: ['done', 'failed', 'blocked', 'cancelled', 'backlog'],
  blocked: ['backlog', 'running', 'cancelled'],
  done: ['backlog', 'cancelled'],
  failed: ['backlog', 'cancelled'],
  cancelled: ['drafting'],
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

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
}

function writeJson(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

function isTerminal(type: CardType): boolean {
  return TERMINAL_TYPES.has(type);
}

function generateId(type: string, existingIds: string[]): string {
  const prefix = type;
  const maxNum = existingIds
    .filter((id) => id.startsWith(prefix + '-'))
    .map((id) => {
      const num = parseInt(id.slice(prefix.length + 1), 10);
      return isNaN(num) ? 0 : num;
    })
    .reduce((max, n) => Math.max(max, n), 0);
  return `${prefix}-${maxNum + 1}`;
}

function now(): string {
  return new Date().toISOString();
}

function formatValidationError(scope: string, path: string, error: { message: string }): Error {
  return new Error(`${scope} at '${path}' is invalid: ${error.message}`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function summarizeChangedFields(changedFields: string[]): string {
  if (changedFields.length === 0) {
    return 'card updated';
  }
  return `${changedFields.join(', ')} updated`;
}

function cardPath(projectRoot: string, id: string): string {
  return join(projectRoot, '.saivage', 'cards', 'by-id', `${id}.json`);
}

function indexPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'index.json');
}

function childrenPath(projectRoot: string, parentId: string): string {
  return join(projectRoot, '.saivage', 'cards', 'tree', `${parentId}.children.json`);
}

function dependsOnPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'dependencies', 'depends-on.json');
}

function blocksPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'dependencies', 'blocks.json');
}

function historyDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'history');
}

/** Card history lives at .saivage/cards/history/<card-id>.history.jsonl. */
function historyPath(projectRoot: string, id: string): string {
  return join(historyDir(projectRoot), `${id}.history.jsonl`);
}

export class CardStore {
  private projectRoot: string;
  private validatedPersistedState = false;
  private readonly testHooks?: CardStoreTestHooks;

  readonly maxDepth: number;

  constructor(projectRoot: string, maxDepth?: number, testHooks?: CardStoreTestHooks) {
    this.projectRoot = projectRoot;
    this.maxDepth = maxDepth !== undefined && maxDepth > 0 ? maxDepth : 5;
    this.testHooks = testHooks;
  }

  private ensurePersistedStateValidated(): void {
    if (this.validatedPersistedState) return;
    this.validatePersistedState();
    this.validatedPersistedState = true;
  }

  private validatePersistedState(): void {
    const index = this.parseCardIndex(readJson(indexPath(this.projectRoot)), indexPath(this.projectRoot));
    for (const id of Object.keys(index.cards)) {
      const cp = cardPath(this.projectRoot, id);
      const raw = readJson(cp);
      if (raw && typeof raw === 'object' && !('version_seq' in (raw as Record<string, unknown>))) {
        throw new Error(
          `Card record '${id}' is legacy data without version_seq. No migration is supported. Run 'saivage reset' to clear .saivage/cards, .saivage/runtime, and .saivage/notes, then restart the project.`,
        );
      }
      const card = this.parseCardRecord(raw, cp);
      this.reconcileCardHistory(card);
    }
  }

  private parseCardIndex(raw: unknown, path: string): CardIndex {
    const parsed = cardIndexSchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError('Card index', path, parsed.error);
    return parsed.data;
  }

  private parseChildrenIndex(raw: unknown, path: string): CardChildrenIndex {
    const parsed = cardChildrenIndexSchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError('Card children index', path, parsed.error);
    return parsed.data;
  }

  private parseDependencyIndex(raw: unknown, path: string, label: string): CardDependencyIndex {
    const parsed = cardDependencyIndexSchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError(label, path, parsed.error);
    return parsed.data;
  }

  private parseBlocksIndex(raw: unknown, path: string): CardBlocksIndex {
    const parsed = cardBlocksIndexSchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError('Card blocks index', path, parsed.error);
    return parsed.data;
  }

  private parseCardRecord(raw: unknown, path: string): CardRecord {
    const parsed = cardRecordSchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError('Card record', path, parsed.error);
    return parsed.data;
  }

  private parseCardHistoryEntry(raw: unknown, path: string): CardHistoryEntry {
    const parsed = cardHistoryEntrySchema.safeParse(raw);
    if (!parsed.success) throw formatValidationError('Card history entry', path, parsed.error);
    return parsed.data;
  }

  private loadIndex(): CardIndex {
    this.ensurePersistedStateValidated();
    const path = indexPath(this.projectRoot);
    return this.parseCardIndex(readJson(path), path);
  }

  private saveIndex(index: CardIndex): void {
    writeJson(indexPath(this.projectRoot), index);
  }

  private loadChildren(parentId: string): CardChildrenIndex {
    const cp = childrenPath(this.projectRoot, parentId);
    if (!existsSync(cp)) return [];
    return this.parseChildrenIndex(readJson(cp), cp);
  }

  private saveChildren(parentId: string, children: CardChildrenIndex): void {
    writeJson(childrenPath(this.projectRoot, parentId), children);
  }

  private loadDependsOn(): CardDependencyIndex {
    const path = dependsOnPath(this.projectRoot);
    return this.parseDependencyIndex(readJson(path), path, 'Card dependency index');
  }

  private saveDependsOn(deps: CardDependencyIndex): void {
    writeJson(dependsOnPath(this.projectRoot), deps);
  }

  private loadBlocks(): CardBlocksIndex {
    const path = blocksPath(this.projectRoot);
    return this.parseBlocksIndex(readJson(path), path);
  }

  private saveBlocks(blks: CardBlocksIndex): void {
    writeJson(blocksPath(this.projectRoot), blks);
  }

  private writeCard(card: CardRecord): void {
    writeJson(cardPath(this.projectRoot, card.id), card);
  }

  private addToIndex(card: CardRecord): void {
    const index = this.loadIndex();
    index.cards[card.id] = { id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title };
    this.saveIndex(index);
  }

  private removeFromIndex(id: string): void {
    const index = this.loadIndex();
    delete index.cards[id];
    this.saveIndex(index);
  }

  private addToChildren(parentId: string, childId: string): void {
    const children = this.loadChildren(parentId);
    if (!children.includes(childId)) {
      children.push(childId);
      this.saveChildren(parentId, children);
    }
  }

  private removeFromChildren(parentId: string, childId: string): void {
    const children = this.loadChildren(parentId);
    const idx = children.indexOf(childId);
    if (idx !== -1) {
      children.splice(idx, 1);
      this.saveChildren(parentId, children);
    }
  }

  private addToDependsOn(cardId: string, dependsOn: string[]): void {
    const deps = this.loadDependsOn();
    deps[cardId] = dependsOn;
    this.saveDependsOn(deps);
  }

  private removeFromDependsOnAll(cardId: string): void {
    const deps = this.loadDependsOn();
    delete deps[cardId];
    for (const key of Object.keys(deps)) {
      deps[key] = deps[key].filter((id) => id !== cardId);
      if (deps[key].length === 0) delete deps[key];
    }
    this.saveDependsOn(deps);
  }

  private loadHistoryEntries(id: string): CardHistoryEntry[] {
    const hp = historyPath(this.projectRoot, id);
    if (!existsSync(hp)) return [];
    const raw = readFileSync(hp, 'utf-8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line, index) => this.parseCardHistoryEntry(JSON.parse(line) as unknown, `${hp}:${index + 1}`));
  }

  private writeHistoryEntries(id: string, entries: CardHistoryEntry[]): void {
    mkdirSync(historyDir(this.projectRoot), { recursive: true });
    const hp = historyPath(this.projectRoot, id);
    const content = entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    writeFileSync(hp, content, 'utf-8');
  }

  private appendHistoryEntry(entry: CardHistoryEntry): void {
    mkdirSync(historyDir(this.projectRoot), { recursive: true });
    appendFileSync(historyPath(this.projectRoot, entry.card_id), `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private reconcileCardHistory(card: CardRecord): void {
    const entries = this.loadHistoryEntries(card.id);
    let dropped = 0;
    while (entries.length > 0 && entries[entries.length - 1]!.version_seq >= card.version_seq) {
      entries.pop();
      dropped += 1;
    }
    if (dropped > 0) {
      console.warn(`Dropped ${dropped} orphan history entr${dropped === 1 ? 'y' : 'ies'} for card '${card.id}' during startup reconciliation.`);
      this.writeHistoryEntries(card.id, entries);
    }
  }

  private validateMutablePatch(existing: CardRecord, changes: Partial<CardRecord>): number {
    if ((changes as { type?: string }).type === 'plan') {
      throw new Error('Cannot change card type to plan: planning state lives on goal cards.');
    }
    if (TERMINAL_STATES.has(existing.status)) {
      for (const key of Object.keys(changes)) {
        if (key !== 'status' && !ALWAYS_ALLOWED_FIELDS.has(key)) {
          throw new Error(`Card '${existing.id}' is in status '${existing.status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`);
        }
      }
    } else if (!FULL_EDIT_STATES.has(existing.status)) {
      for (const key of Object.keys(changes)) {
        if (CRITICAL_FIELDS.has(key)) {
          throw new Error(`Field '${key}' cannot be changed on a card in status '${existing.status}'. Cards in this state allow editing: status, title, description, priority, urgency, tags, and other non-structural fields.`);
        }
      }
    }
    if (changes.type !== undefined && changes.type !== existing.type && isTerminal(changes.type)) {
      const children = this.loadChildren(existing.id);
      if (children.length > 0) {
        throw new Error(`Cannot change type of card '${existing.id}' to '${changes.type}' because it has ${children.length} child(ren). Terminal cards cannot have children.`);
      }
    }
    let newDepth = existing.depth;
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (changes.parent !== null) {
        const newParent = this.read(changes.parent);
        if (!newParent) throw new Error(`Parent card '${changes.parent}' does not exist.`);
        if (isTerminal(newParent.type)) {
          throw new Error(`Cannot set parent to '${changes.parent}' because it is a terminal card (type: ${newParent.type}). Terminal cards cannot have children.`);
        }
        newDepth = newParent.depth + 1;
      } else {
        newDepth = 0;
      }
      if (newDepth > this.maxDepth) {
        throw new Error(`Cannot update card '${existing.id}' to depth ${newDepth}. Maximum allowed depth is ${this.maxDepth}. Choose a parent at a shallower level.`);
      }
    }
    return newDepth;
  }

  private buildUpdatedCard(existing: CardRecord, changes: Partial<CardRecord>, stamp: string): CardRecord {
    const newDepth = this.validateMutablePatch(existing, changes);
    const newDependsOn = changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;
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
      version_seq: existing.version_seq,
    };
  }

  private persistMutation(existing: CardRecord, updated: CardRecord, changes: Partial<CardRecord>): CardRecord {
    const parsed = cardRecordSchema.safeParse(updated);
    if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
    if (changes.depends_on !== undefined) {
      const cycle = this.detectCycles(existing.id, updated.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (existing.parent !== null) this.removeFromChildren(existing.parent, existing.id);
      if (updated.parent !== null) this.addToChildren(updated.parent, existing.id);
    }
    this.writeCard(updated);
    const index = this.loadIndex();
    index.cards[existing.id] = { id: updated.id, type: updated.type, parent: updated.parent, status: updated.status, title: updated.title };
    this.saveIndex(index);
    if (changes.depends_on !== undefined) {
      if (updated.depends_on.length > 0) this.addToDependsOn(existing.id, updated.depends_on);
      else {
        const deps = this.loadDependsOn();
        delete deps[existing.id];
        this.saveDependsOn(deps);
      }
    }
    this.recomputeBlocks();
    return this.read(existing.id)!;
  }

  create(input: Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq'> & { id?: string }): CardRecord {
    this.ensurePersistedStateValidated();
    if ((input as { type: string }).type === 'plan') throw new Error('Plan cards are no longer created. Planning state lives on goal cards.');
    const nowStamp = now();
    let id: string;
    if (input.id) id = input.id;
    else if (input.type === 'project') id = 'project';
    else {
      const index = this.loadIndex();
      id = generateId(input.type, Object.keys(index.cards));
    }
    if (input.type === 'project') {
      const index = this.loadIndex();
      const existingProject = Object.values(index.cards).find((c) => c.type === 'project');
      if (existingProject) throw new Error(`Cannot create duplicate project card. A project card already exists with id '${existingProject.id}'.`);
    }
    if (input.parent !== null) {
      const parentCard = this.read(input.parent);
      if (!parentCard) throw new Error(`Parent card '${input.parent}' does not exist.`);
      if (isTerminal(parentCard.type)) throw new Error(`Cannot create child under terminal card '${input.parent}' (type: ${parentCard.type}). Terminal cards cannot have children.`);
      if (TERMINAL_STATES.has(parentCard.status)) throw new Error(`Cannot create child under card '${input.parent}' because it is in status '${parentCard.status}'. Children cannot be created under cards in ${parentCard.status} status.`);
    }
    const depth = input.parent === null ? 0 : this.read(input.parent)!.depth + 1;
    if (depth > this.maxDepth) throw new Error(`Cannot create card at depth ${depth}. Maximum allowed depth is ${this.maxDepth}. Reduce nesting depth by reorganizing the card hierarchy.`);
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
      retries: input.retries,
      version_seq: 1,
    };
    const parsed = cardRecordSchema.safeParse(card);
    if (!parsed.success) throw new Error(`Card validation failed: ${parsed.error.message}`);
    if (card.depends_on.length > 0) {
      const cycle = this.detectCycles(card.id, card.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    this.writeCard(card);
    this.addToIndex(card);
    if (card.parent !== null) this.addToChildren(card.parent, card.id);
    if (card.depends_on.length > 0) this.addToDependsOn(card.id, card.depends_on);
    this.recomputeBlocks();
    return card;
  }

  read(id: string): CardRecord | null {
    this.ensurePersistedStateValidated();
    const cp = cardPath(this.projectRoot, id);
    if (!existsSync(cp)) return null;
    const card = this.parseCardRecord(readJson(cp), cp);
    const blocksIndex = this.loadBlocks();
    card.blocks = blocksIndex[id] ?? [];
    return card;
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    this.ensurePersistedStateValidated();
    const existing = this.read(id);
    if (!existing) throw new Error(`Card '${id}' not found.`);
    const updated = this.buildUpdatedCard(existing, changes, now());
    return this.persistMutation(existing, updated, changes);
  }

  mutateCard(id: string, changes: Partial<CardRecord>, ctx: CardMutationContext): CardRecord {
    this.ensurePersistedStateValidated();
    const existing = this.read(id);
    if (!existing) throw new Error(`Card '${id}' not found.`);
    const stamp = now();
    const candidate = this.buildUpdatedCard(existing, changes, stamp);
    const changedFields = TRACKED_FIELDS.filter(
      (field) => changes[field] !== undefined && !valuesEqual(existing[field], candidate[field]),
    );
    if (changedFields.length === 0) return this.persistMutation(existing, candidate, changes);

    const updated: CardRecord = { ...candidate, version_seq: existing.version_seq + 1 };
    const parsedUpdated = cardRecordSchema.safeParse(updated);
    if (!parsedUpdated.success) throw new Error(`Card validation failed: ${parsedUpdated.error.message}`);
    if (changes.depends_on !== undefined) {
      const cycle = this.detectCycles(existing.id, updated.depends_on);
      if (cycle.length > 0) throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }

    const historyEntry: CardHistoryEntry = {
      card_id: existing.id,
      version_seq: existing.version_seq,
      snapshot: deepClone(existing),
      changed_at: stamp,
      changed_by_actor: ctx.actor,
      changed_by_surface: ctx.surface,
      change_reason: ctx.reason ?? null,
      changed_fields: [...changedFields],
      change_summary: summarizeChangedFields(changedFields),
    };
    const parsedHistory = cardHistoryEntrySchema.safeParse(historyEntry);
    if (!parsedHistory.success) throw new Error(`Card history validation failed: ${parsedHistory.error.message}`);

    this.appendHistoryEntry(parsedHistory.data);
    this.testHooks?.beforeTrackedCardRename?.(updated, parsedHistory.data);
    const tmpPath = `${cardPath(this.projectRoot, id)}.tmp`;
    mkdirSync(join(this.projectRoot, '.saivage', 'cards', 'by-id'), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, cardPath(this.projectRoot, id));

    const index = this.loadIndex();
    index.cards[id] = { id: updated.id, type: updated.type, parent: updated.parent, status: updated.status, title: updated.title };
    this.saveIndex(index);
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (existing.parent !== null) this.removeFromChildren(existing.parent, id);
      if (updated.parent !== null) this.addToChildren(updated.parent, id);
    }
    if (changes.depends_on !== undefined) {
      if (updated.depends_on.length > 0) this.addToDependsOn(id, updated.depends_on);
      else {
        const deps = this.loadDependsOn();
        delete deps[id];
        this.saveDependsOn(deps);
      }
    }
    this.recomputeBlocks();
    const persisted = this.read(id)!;
    broadcastCardHistoryAppended({
      card_id: persisted.id,
      version_seq: persisted.version_seq,
      changed_fields: [...changedFields],
      changed_at: historyEntry.changed_at,
    });
    enqueueCardMutationNotifications(this.projectRoot, persisted, changedFields as string[], { actor: ctx.actor, surface: ctx.surface });
    return persisted;
  }

  listCardHistory(id: string): CardHistoryEntry[] {
    this.ensurePersistedStateValidated();
    return this.loadHistoryEntries(id).slice().reverse();
  }

  getCardAt(id: string, versionSeq: number): CardRecord {
    const current = this.read(id);
    if (!current) throw new Error(`Card '${id}' not found.`);
    if (versionSeq === current.version_seq) return current;
    const entry = this.loadHistoryEntries(id).find((candidate) => candidate.version_seq === versionSeq);
    if (!entry) throw new Error(`Card '${id}' has no version ${versionSeq}.`);
    return deepClone(entry.snapshot);
  }

  diffCard(id: string, fromSeq: number, toSeq: number): CardDiffEntry[] {
    const from = this.getCardAt(id, fromSeq);
    const to = this.getCardAt(id, toSeq);
    const fields = new Set<keyof CardRecord>([
      ...Object.keys(from) as Array<keyof CardRecord>,
      ...Object.keys(to) as Array<keyof CardRecord>,
    ]);
    return Array.from(fields)
      .filter((field) => !valuesEqual(from[field], to[field]))
      .map((field) => ({ field, before: from[field], after: to[field] }));
  }

  delete(id: string): void {
    this.ensurePersistedStateValidated();
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (TERMINAL_STATES.has(card.status)) throw new Error(`Cannot delete card '${id}' because it is in status '${card.status}'. Cards in ${card.status} status cannot be deleted.`);
    if (id === 'project') throw new Error('Cannot delete the project card.');
    const children = this.loadChildren(id);
    if (children.length > 0) throw new Error(`Cannot delete card '${id}' because it has ${children.length} child(ren). Delete children first.`);
    if (card.parent !== null) this.removeFromChildren(card.parent, id);
    this.removeFromIndex(id);
    this.removeFromDependsOnAll(id);
    const cp = childrenPath(this.projectRoot, id);
    if (existsSync(cp)) unlinkSync(cp);
    const cfp = cardPath(this.projectRoot, id);
    if (existsSync(cfp)) unlinkSync(cfp);
    const hp = historyPath(this.projectRoot, id);
    if (existsSync(hp)) unlinkSync(hp);
    this.recomputeBlocks();
  }

  list(): CardRecord[] {
    this.ensurePersistedStateValidated();
    const index = this.loadIndex();
    const cards: CardRecord[] = [];
    for (const id of Object.keys(index.cards)) {
      const card = this.read(id);
      if (card) cards.push(card);
    }
    return cards;
  }

  listChildren(parentId: string): string[] { return this.loadChildren(parentId); }

  getAncestors(id: string): string[] {
    const ancestors: string[] = [];
    let current = this.read(id);
    if (!current) return [];
    while (current && current.parent !== null) {
      ancestors.unshift(current.parent);
      current = this.read(current.parent);
    }
    return ancestors;
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    return this.getAncestors(id).includes(ancestorId);
  }

  getDescendantIds(id: string): string[] {
    const result: string[] = [];
    const stack = [...this.loadChildren(id)];
    while (stack.length > 0) {
      const childId = stack.pop()!;
      result.push(childId);
      stack.push(...this.loadChildren(childId));
    }
    return result;
  }

  updateDependsOn(id: string, newDependsOn: string[], ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'dependency update' }): CardRecord {
    return this.mutateCard(id, { depends_on: newDependsOn }, ctx);
  }

  recomputeBlocks(): void {
    const deps = this.loadDependsOn();
    const allCards = this.loadIndex();
    const blocks: CardBlocksIndex = {};
    for (const cardId of Object.keys(allCards.cards)) blocks[cardId] = [];
    for (const [cardId, dependsOnList] of Object.entries(deps)) {
      for (const dep of dependsOnList) {
        if (blocks[dep]) blocks[dep].push(cardId);
        else blocks[dep] = [cardId];
      }
    }
    this.saveBlocks(blocks);
  }

  detectCycles(id: string, newDependsOn: string[]): string[] {
    const deps = this.loadDependsOn();
    const graph: Record<string, string[]> = {};
    for (const [cardId, dependsOnList] of Object.entries(deps)) graph[cardId] = [...dependsOnList];
    if (newDependsOn.length > 0) graph[id] = [...newDependsOn];
    else delete graph[id];
    const allCards = this.loadIndex();
    for (const cardId of Object.keys(allCards.cards)) if (!(cardId in graph)) graph[cardId] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();
    function dfs(node: string, path: string[]): string[] | null {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        return [...path.slice(cycleStart), node];
      }
      if (visited.has(node)) return null;
      visited.add(node);
      stack.add(node);
      for (const neighbor of graph[node] || []) {
        const result = dfs(neighbor, [...path, node]);
        if (result) return result;
      }
      stack.delete(node);
      return null;
    }
    return dfs(id, []) ?? [];
  }

  validateTransition(from: CardStatus, to: CardStatus): void {
    if (from === to) return;
    const allowed = VALID_TRANSITIONS[from];
    if (allowed && allowed.includes(to)) return;
    throw new Error(`Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${allowed ? allowed.join(', ') : 'none'}.`);
  }

  setStatus(id: string, newStatus: CardStatus): CardRecord {
    const card = this.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    this.validateTransition(card.status, newStatus);
    return this.update(id, { status: newStatus });
  }

  activateGoal(id: string): { goal: CardRecord } {
    const goal = this.read(id);
    if (!goal) throw new Error(`Goal '${id}' not found.`);
    if (goal.type !== 'project' && goal.type !== 'goal') throw new Error(`activateGoal requires a project or goal card, got type '${goal.type}'.`);
    const activeGoal = goal.status === 'active' || goal.status === 'running' ? goal : this.setStatus(id, 'active');
    const existingResult = activeGoal.result && typeof activeGoal.result === 'object' ? activeGoal.result : {};
    if (existingResult.planning && typeof existingResult.planning === 'object') return { goal: activeGoal };
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
        },
      }),
    };
  }

  resetHistoryForTests(id: string): void {
    const hp = historyPath(this.projectRoot, id);
    if (existsSync(hp)) rmSync(hp, { force: true });
  }
}
