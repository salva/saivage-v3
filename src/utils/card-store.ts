import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardBlocksIndexSchema,
  cardChildrenIndexSchema,
  cardDependencyIndexSchema,
  cardIndexSchema,
  cardRecordSchema,
} from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';
import type {
  CardBlocksIndex,
  CardChildrenIndex,
  CardDependencyIndex,
  CardIndex,
  CardIndexEntry,
  CardRecord,
  CardStatus,
  CardType,
} from '../schemas/types.js';

// ── Constants ─────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────

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

// ── File Path Helpers ─────────────────────────────────────────

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

// ── Card Store ────────────────────────────────────────────────

export class CardStore {
  private projectRoot: string;

  readonly maxDepth: number;

  constructor(projectRoot: string, maxDepth?: number) {
    this.projectRoot = projectRoot;
    this.maxDepth = maxDepth !== undefined && maxDepth > 0 ? maxDepth : 5;
  }

  private parseCardIndex(raw: unknown, path: string): CardIndex {
    const parsed = cardIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw formatValidationError('Card index', path, parsed.error);
    }
    return parsed.data;
  }

  private parseChildrenIndex(raw: unknown, path: string): CardChildrenIndex {
    const parsed = cardChildrenIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw formatValidationError('Card children index', path, parsed.error);
    }
    return parsed.data;
  }

  private parseDependencyIndex(raw: unknown, path: string, label: string): CardDependencyIndex {
    const parsed = cardDependencyIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw formatValidationError(label, path, parsed.error);
    }
    return parsed.data;
  }

  private parseBlocksIndex(raw: unknown, path: string): CardBlocksIndex {
    const parsed = cardBlocksIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw formatValidationError('Card blocks index', path, parsed.error);
    }
    return parsed.data;
  }

  private parseCardRecord(raw: unknown, path: string): CardRecord {
    const parsed = cardRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw formatValidationError('Card record', path, parsed.error);
    }
    return parsed.data;
  }

  // ── Index Helpers ─────────────────────────────────────────

  private loadIndex(): CardIndex {
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

  // ── Card File Operations ─────────────────────────────────

  private writeCard(card: CardRecord): void {
    writeJson(cardPath(this.projectRoot, card.id), card);
  }

  // ── Index Updates ────────────────────────────────────────

  private addToIndex(card: CardRecord): void {
    const index = this.loadIndex();
    index.cards[card.id] = {
      id: card.id,
      type: card.type,
      parent: card.parent,
      status: card.status,
      title: card.title,
    };
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
      if (deps[key].length === 0) {
        delete deps[key];
      }
    }
    this.saveDependsOn(deps);
  }

  create(
    input: Omit<CardRecord, 'created_at' | 'updated_at' | 'id'> & {
      id?: string;
    },
  ): CardRecord {
    if ((input as { type: string }).type === 'plan') {
      throw new Error('Plan cards are no longer created. Planning state lives on goal cards.');
    }

    const nowStamp = now();

    let id: string;
    if (input.id) {
      id = input.id;
    } else if (input.type === 'project') {
      id = 'project';
    } else {
      const index = this.loadIndex();
      const existingIds = Object.keys(index.cards);
      id = generateId(input.type, existingIds);
    }

    if (input.type === 'project') {
      const index = this.loadIndex();
      const existingProject = Object.values(index.cards).find((c) => c.type === 'project');
      if (existingProject) {
        throw new Error(
          `Cannot create duplicate project card. A project card already exists with id '${existingProject.id}'.`,
        );
      }
    }

    if (input.parent !== null) {
      const parentCard = this.read(input.parent);
      if (!parentCard) {
        throw new Error(`Parent card '${input.parent}' does not exist.`);
      }
      if (isTerminal(parentCard.type)) {
        throw new Error(
          `Cannot create child under terminal card '${input.parent}' (type: ${parentCard.type}). Terminal cards cannot have children.`,
        );
      }
      if (TERMINAL_STATES.has(parentCard.status)) {
        throw new Error(
          `Cannot create child under card '${input.parent}' because it is in status '${parentCard.status}'. Children cannot be created under cards in ${parentCard.status} status.`,
        );
      }
    }

    let depth: number;
    if (input.parent === null) {
      depth = 0;
    } else {
      const parentCard = this.read(input.parent);
      if (!parentCard) {
        throw new Error(`Parent card '${input.parent}' not found.`);
      }
      depth = parentCard.depth + 1;
    }

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
      retries: input.retries,
    };

    const parsed = cardRecordSchema.safeParse(card);
    if (!parsed.success) {
      throw new Error(`Card validation failed: ${parsed.error.message}`);
    }

    if (card.depends_on.length > 0) {
      const cycle = this.detectCycles(card.id, card.depends_on);
      if (cycle.length > 0) {
        throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
    }

    this.writeCard(card);
    this.addToIndex(card);

    if (card.parent !== null) {
      this.addToChildren(card.parent, card.id);
    }

    if (card.depends_on.length > 0) {
      this.addToDependsOn(card.id, card.depends_on);
    }

    this.recomputeBlocks();

    return card;
  }

  read(id: string): CardRecord | null {
    const cp = cardPath(this.projectRoot, id);
    if (!existsSync(cp)) {
      return null;
    }
    const card = this.parseCardRecord(readJson(cp), cp);
    const blocksIndex = this.loadBlocks();
    card.blocks = blocksIndex[id] ?? [];
    return card;
  }

  update(id: string, changes: Partial<CardRecord>): CardRecord {
    const existing = this.read(id);
    if (!existing) {
      throw new Error(`Card '${id}' not found.`);
    }

    if ((changes as { type?: string }).type === 'plan') {
      throw new Error('Cannot change card type to plan: planning state lives on goal cards.');
    }

    if (TERMINAL_STATES.has(existing.status)) {
      for (const key of Object.keys(changes)) {
        if (key !== 'status' && !ALWAYS_ALLOWED_FIELDS.has(key)) {
          throw new Error(
            `Card '${id}' is in status '${existing.status}'. Cards in this state cannot be edited. Use setStatus() to reopen the card first.`,
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

    if (changes.type !== undefined && changes.type !== existing.type) {
      if (isTerminal(changes.type)) {
        const children = this.loadChildren(id);
        if (children.length > 0) {
          throw new Error(
            `Cannot change type of card '${id}' to '${changes.type}' because it has ${children.length} child(ren). Terminal cards cannot have children.`,
          );
        }
      }
    }

    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (changes.parent !== null) {
        const newParent = this.read(changes.parent);
        if (!newParent) {
          throw new Error(`Parent card '${changes.parent}' does not exist.`);
        }
        if (isTerminal(newParent.type)) {
          throw new Error(
            `Cannot set parent to '${changes.parent}' because it is a terminal card (type: ${newParent.type}). Terminal cards cannot have children.`,
          );
        }
      }
    }

    let newDepth = existing.depth;
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (changes.parent === null) {
        newDepth = 0;
      } else {
        const newParent = this.read(changes.parent);
        if (!newParent) {
          throw new Error(`Parent card '${changes.parent}' not found.`);
        }
        newDepth = newParent.depth + 1;
      }

      if (newDepth > this.maxDepth) {
        throw new Error(
          `Cannot update card '${id}' to depth ${newDepth}. Maximum allowed depth is ${this.maxDepth}. Choose a parent at a shallower level.`,
        );
      }
    }

    const newDependsOn =
      changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;

    const updated: CardRecord = {
      ...existing,
      ...changes,
      id: existing.id,
      type: changes.type ?? existing.type,
      created_at: existing.created_at,
      updated_at: now(),
      depth: newDepth,
      depends_on: newDependsOn,
      blocks: existing.blocks,
    };

    const parsed = cardRecordSchema.safeParse(updated);
    if (!parsed.success) {
      throw new Error(`Card validation failed: ${parsed.error.message}`);
    }

    if (changes.depends_on !== undefined) {
      const cycle = this.detectCycles(id, newDependsOn);
      if (cycle.length > 0) {
        throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
    }

    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (existing.parent !== null) {
        this.removeFromChildren(existing.parent, id);
      }
      if (changes.parent !== null) {
        this.addToChildren(changes.parent, id);
      }
    }

    this.writeCard(updated);

    const index = this.loadIndex();
    index.cards[id] = {
      id: updated.id,
      type: updated.type,
      parent: updated.parent,
      status: updated.status,
      title: updated.title,
    };
    this.saveIndex(index);

    if (changes.depends_on !== undefined) {
      if (newDependsOn.length > 0) {
        this.addToDependsOn(id, newDependsOn);
      } else {
        const deps = this.loadDependsOn();
        delete deps[id];
        this.saveDependsOn(deps);
      }
    }

    this.recomputeBlocks();

    return this.read(id)!;
  }

  delete(id: string): void {
    const card = this.read(id);
    if (!card) {
      throw new Error(`Card '${id}' not found.`);
    }

    if (TERMINAL_STATES.has(card.status)) {
      throw new Error(
        `Cannot delete card '${id}' because it is in status '${card.status}'. Cards in ${card.status} status cannot be deleted.`,
      );
    }

    if (id === 'project') {
      throw new Error('Cannot delete the project card.');
    }

    const children = this.loadChildren(id);
    if (children.length > 0) {
      throw new Error(
        `Cannot delete card '${id}' because it has ${children.length} child(ren). Delete children first.`,
      );
    }

    if (card.parent !== null) {
      this.removeFromChildren(card.parent, id);
    }

    this.removeFromIndex(id);
    this.removeFromDependsOnAll(id);

    const cp = childrenPath(this.projectRoot, id);
    if (existsSync(cp)) {
      unlinkSync(cp);
    }

    const cfp = cardPath(this.projectRoot, id);
    if (existsSync(cfp)) {
      unlinkSync(cfp);
    }

    this.recomputeBlocks();
  }

  list(): CardRecord[] {
    const index = this.loadIndex();
    const cards: CardRecord[] = [];
    for (const id of Object.keys(index.cards)) {
      const card = this.read(id);
      if (card) {
        cards.push(card);
      }
    }
    return cards;
  }

  listChildren(parentId: string): string[] {
    return this.loadChildren(parentId);
  }

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
    const ancestors = this.getAncestors(id);
    return ancestors.includes(ancestorId);
  }

  getDescendantIds(id: string): string[] {
    const result: string[] = [];
    const stack = [...this.loadChildren(id)];

    while (stack.length > 0) {
      const childId = stack.pop()!;
      result.push(childId);
      const grandchildren = this.loadChildren(childId);
      stack.push(...grandchildren);
    }

    return result;
  }

  updateDependsOn(id: string, newDependsOn: string[]): CardRecord {
    return this.update(id, { depends_on: newDependsOn });
  }

  recomputeBlocks(): void {
    const deps = this.loadDependsOn();
    const allCards = this.loadIndex();
    const blocks: CardBlocksIndex = {};

    for (const cardId of Object.keys(allCards.cards)) {
      blocks[cardId] = [];
    }

    for (const [cardId, dependsOnList] of Object.entries(deps)) {
      for (const dep of dependsOnList) {
        if (blocks[dep]) {
          blocks[dep].push(cardId);
        } else {
          blocks[dep] = [cardId];
        }
      }
    }

    this.saveBlocks(blocks);
  }

  detectCycles(id: string, newDependsOn: string[]): string[] {
    const deps = this.loadDependsOn();
    const graph: Record<string, string[]> = {};

    for (const [cardId, dependsOnList] of Object.entries(deps)) {
      graph[cardId] = [...dependsOnList];
    }

    if (newDependsOn.length > 0) {
      graph[id] = [...newDependsOn];
    } else {
      delete graph[id];
    }

    const allCards = this.loadIndex();
    for (const cardId of Object.keys(allCards.cards)) {
      if (!(cardId in graph)) {
        graph[cardId] = [];
      }
    }

    const visited = new Set<string>();
    const stack = new Set<string>();

    function dfs(node: string, path: string[]): string[] | null {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        return [...path.slice(cycleStart), node];
      }

      if (visited.has(node)) {
        return null;
      }

      visited.add(node);
      stack.add(node);

      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        const result = dfs(neighbor, [...path, node]);
        if (result) return result;
      }

      stack.delete(node);
      return null;
    }

    const result = dfs(id, []);
    return result ?? [];
  }

  validateTransition(from: CardStatus, to: CardStatus): void {
    if (from === to) return;

    const allowed = VALID_TRANSITIONS[from];
    if (allowed && allowed.includes(to)) return;

    const validList = allowed ? allowed.join(', ') : 'none';
    throw new Error(
      `Invalid transition: ${from} → ${to}. Valid transitions from ${from} are: ${validList}.`,
    );
  }

  setStatus(id: string, newStatus: CardStatus): CardRecord {
    const card = this.read(id);
    if (!card) {
      throw new Error(`Card '${id}' not found.`);
    }

    this.validateTransition(card.status, newStatus);

    return this.update(id, { status: newStatus });
  }

  activateGoal(id: string): { goal: CardRecord } {
    const goal = this.read(id);
    if (!goal) {
      throw new Error(`Goal '${id}' not found.`);
    }

    if (goal.type !== 'project' && goal.type !== 'goal') {
      throw new Error(`activateGoal requires a project or goal card, got type '${goal.type}'.`);
    }

    const activeGoal = goal.status === 'active' || goal.status === 'running'
      ? goal
      : this.setStatus(id, 'active');
    const existingResult = activeGoal.result && typeof activeGoal.result === 'object' ? activeGoal.result : {};
    if (existingResult.planning && typeof existingResult.planning === 'object') {
      return { goal: activeGoal };
    }

    const updatedGoal = this.update(id, {
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
    });

    return { goal: updatedGoal };
  }
}
