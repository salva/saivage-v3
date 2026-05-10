import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cardRecordSchema } from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';
import type { CardRecord, CardType, CardStatus } from '../schemas/types.js';

// ── Index Types ───────────────────────────────────────────────

export interface CardIndexEntry {
  id: string;
  type: string;
  parent: string | null;
  status: string;
  title: string;
}

export interface CardIndex {
  cards: Record<string, CardIndexEntry>;
}

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

const PLAN_CARD_ID_PREFIX = 'plan-';

// ── Helpers ───────────────────────────────────────────────────

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
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

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  // ── Index Helpers ─────────────────────────────────────────

  private loadIndex(): CardIndex {
    return readJson<CardIndex>(indexPath(this.projectRoot));
  }

  private saveIndex(index: CardIndex): void {
    writeJson(indexPath(this.projectRoot), index);
  }

  private loadChildren(parentId: string): string[] {
    const cp = childrenPath(this.projectRoot, parentId);
    if (!existsSync(cp)) return [];
    return readJson<string[]>(cp);
  }

  private saveChildren(parentId: string, children: string[]): void {
    writeJson(childrenPath(this.projectRoot, parentId), children);
  }

  private loadDependsOn(): Record<string, string[]> {
    return readJson<Record<string, string[]>>(dependsOnPath(this.projectRoot));
  }

  private saveDependsOn(deps: Record<string, string[]>): void {
    writeJson(dependsOnPath(this.projectRoot), deps);
  }

  private loadBlocks(): Record<string, string[]> {
    return readJson<Record<string, string[]>>(blocksPath(this.projectRoot));
  }

  private saveBlocks(blks: Record<string, string[]>): void {
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
    // Remove cardId from the depends_on index (its own entry)
    const deps = this.loadDependsOn();
    delete deps[cardId];

    // Also remove cardId from every other card's depends_on list
    for (const key of Object.keys(deps)) {
      deps[key] = deps[key].filter((id) => id !== cardId);
      if (deps[key].length === 0) {
        delete deps[key];
      }
    }
    this.saveDependsOn(deps);
  }

  // ── CRUD: Create ─────────────────────────────────────────

  /**
   * Create a new card.
   *
   * @param input - Card fields. `id` is optional; auto-generated if not provided.
   *   'project' cards always get id 'project'. Plan cards cannot be created
   *   manually (use activateGoal).
   */
  create(
    input: Omit<CardRecord, 'created_at' | 'updated_at' | 'id'> & {
      id?: string;
    },
  ): CardRecord {
    const nowStamp = now();

    // Determine ID
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

    // Enforce: singleton project
    if (input.type === 'project') {
      const index = this.loadIndex();
      const existingProject = Object.values(index.cards).find((c) => c.type === 'project');
      if (existingProject) {
        throw new Error(
          `Cannot create duplicate project card. A project card already exists with id '${existingProject.id}'.`,
        );
      }
    }

    // Enforce: plan cards cannot be created manually
    if (input.type === 'plan') {
      throw new Error(
        'Plan cards cannot be created manually. Use activateGoal() to auto-create a plan card.',
      );
    }

    // Enforce: terminal cards cannot have children (create with parent check)
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
    }

    // Compute depth
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

    const card: CardRecord = {
      id,
      type: input.type,
      parent: input.parent,
      depth,
      title: input.title,
      description: input.description,
      status: input.status,
      subtype: input.subtype ?? null,
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

    // Validate
    const parsed = cardRecordSchema.safeParse(card);
    if (!parsed.success) {
      throw new Error(`Card validation failed: ${parsed.error.message}`);
    }

    // Check dependency cycles before writing
    if (card.depends_on.length > 0) {
      const cycle = this.detectCycles(card.id, card.depends_on);
      if (cycle.length > 0) {
        throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
    }

    // Write card file
    this.writeCard(card);

    // Update index
    this.addToIndex(card);

    // Update parent's children list
    if (card.parent !== null) {
      this.addToChildren(card.parent, card.id);
    }

    // Update depends_on
    if (card.depends_on.length > 0) {
      this.addToDependsOn(card.id, card.depends_on);
    }

    // Recompute blocks
    this.recomputeBlocks();

    return card;
  }

  // ── CRUD: Read ───────────────────────────────────────────

  /**
   * Read a card by ID. Returns null if not found.
   *
   * The `blocks` field is merged from the global blocks index so that
   * the returned card always reflects the current computed blocks,
   * not any stale value persisted in the card file.
   */
  read(id: string): CardRecord | null {
    const cp = cardPath(this.projectRoot, id);
    if (!existsSync(cp)) {
      return null;
    }
    const card = readJson<CardRecord>(cp);

    // Merge the computed blocks from the blocks index
    // so card.blocks always reflects the current state
    const blocksIndex = this.loadBlocks();
    card.blocks = blocksIndex[id] ?? [];

    return card;
  }

  // ── CRUD: Update ─────────────────────────────────────────

  /**
   * Update a card's fields. Does not change id, type, created_at.
   * Recomputes blocks automatically if depends_on changed.
   */
  update(id: string, changes: Partial<CardRecord>): CardRecord {
    const existing = this.read(id);
    if (!existing) {
      throw new Error(`Card '${id}' not found.`);
    }

    // Disallow changing type to terminal while card has children
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

    // Disallow changing parent to a terminal card
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

    // Recompute depth if parent changed
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
    }

    // Determine which depends_on to use
    const newDependsOn =
      changes.depends_on !== undefined ? changes.depends_on : existing.depends_on;

    // Build the updated card
    const updated: CardRecord = {
      ...existing,
      ...changes,
      id: existing.id, // immutable
      type: changes.type ?? existing.type,
      created_at: existing.created_at, // immutable
      updated_at: now(),
      depth: newDepth,
      depends_on: newDependsOn,
      blocks: existing.blocks, // will be recomputed
    };

    // Disallow changing type to plan manually
    if (changes.type === 'plan' && existing.type !== 'plan') {
      throw new Error(`Cannot change card type to 'plan' manually. Plan cards are auto-created.`);
    }

    // Validate
    const parsed = cardRecordSchema.safeParse(updated);
    if (!parsed.success) {
      throw new Error(`Card validation failed: ${parsed.error.message}`);
    }

    // Check dependency cycles if depends_on changed
    if (changes.depends_on !== undefined) {
      const cycle = this.detectCycles(id, newDependsOn);
      if (cycle.length > 0) {
        throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      }
    }

    // Update parent/children tracking if parent changed
    if (changes.parent !== undefined && changes.parent !== existing.parent) {
      if (existing.parent !== null) {
        this.removeFromChildren(existing.parent, id);
      }
      if (changes.parent !== null) {
        this.addToChildren(changes.parent, id);
      }
    }

    // Write card
    this.writeCard(updated);

    // Update index
    const index = this.loadIndex();
    index.cards[id] = {
      id: updated.id,
      type: updated.type,
      parent: updated.parent,
      status: updated.status,
      title: updated.title,
    };
    this.saveIndex(index);

    // Update depends_on if changed
    if (changes.depends_on !== undefined) {
      if (newDependsOn.length > 0) {
        this.addToDependsOn(id, newDependsOn);
      } else {
        // Remove empty entry
        const deps = this.loadDependsOn();
        delete deps[id];
        this.saveDependsOn(deps);
      }
    }

    // Recompute blocks
    this.recomputeBlocks();

    // Re-read the card to get the updated blocks
    return this.read(id)!;
  }

  // ── CRUD: Delete ─────────────────────────────────────────

  /**
   * Delete a card and clean up all references.
   *
   * Guards:
   * - Cannot delete project card (id: 'project')
   * - Cannot delete a card that has children
   * - Cannot delete a plan card
   */
  delete(id: string): void {
    const card = this.read(id);
    if (!card) {
      throw new Error(`Card '${id}' not found.`);
    }

    if (id === 'project') {
      throw new Error('Cannot delete the project card.');
    }

    if (card.type === 'plan') {
      throw new Error(
        'Cannot delete a plan card directly. Plan cards are managed by their goal lifecycle.',
      );
    }

    // Check for children
    const children = this.loadChildren(id);
    if (children.length > 0) {
      throw new Error(
        `Cannot delete card '${id}' because it has ${children.length} child(ren). Delete children first.`,
      );
    }

    // Remove from parent's children list
    if (card.parent !== null) {
      this.removeFromChildren(card.parent, id);
    }

    // Remove from index
    this.removeFromIndex(id);

    // Remove from depends_on / blocks
    this.removeFromDependsOnAll(id);

    // Remove children file if it exists
    const cp = childrenPath(this.projectRoot, id);
    if (existsSync(cp)) {
      unlinkSync(cp);
    }

    // Remove card file
    const cfp = cardPath(this.projectRoot, id);
    if (existsSync(cfp)) {
      unlinkSync(cfp);
    }

    // Recompute blocks
    this.recomputeBlocks();
  }

  // ── List ─────────────────────────────────────────────────

  /**
   * List all card records.
   */
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

  /**
   * List child IDs of a given parent.
   */
  listChildren(parentId: string): string[] {
    return this.loadChildren(parentId);
  }

  // ── Hierarchy Queries ────────────────────────────────────

  /**
   * Get ancestors of a card, ordered root → parent.
   * Returns empty array for the root card.
   */
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

  /**
   * Check whether `id` is a descendant of `ancestorId`.
   */
  isDescendantOf(id: string, ancestorId: string): boolean {
    const ancestors = this.getAncestors(id);
    return ancestors.includes(ancestorId);
  }

  /**
   * Get all descendant IDs recursively.
   */
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

  // ── Dependency Management ────────────────────────────────

  /**
   * Update the depends_on for a card. Validates no cycles.
   */
  updateDependsOn(id: string, newDependsOn: string[]): CardRecord {
    return this.update(id, { depends_on: newDependsOn });
  }

  /**
   * Recompute the blocks index from scratch.
   * blocks[c] = list of all cards that have c in their depends_on
   */
  recomputeBlocks(): void {
    const deps = this.loadDependsOn();
    const allCards = this.loadIndex();
    const blocks: Record<string, string[]> = {};

    // Initialize blocks for all cards
    for (const cardId of Object.keys(allCards.cards)) {
      blocks[cardId] = [];
    }

    // For each card that has depends_on, add this card to the blocks of
    // each dependency
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

  /**
   * Detect if adding the given depends_on list to `id` would create a cycle.
   * Returns the cycle path as an array of card IDs if found, or an empty array.
   *
   * This simulates what the dependency graph would look like after the change.
   */
  detectCycles(id: string, newDependsOn: string[]): string[] {
    // Build the full dependency graph as it would be after the change
    const deps = this.loadDependsOn();
    const graph: Record<string, string[]> = {};

    // Copy existing deps
    for (const [cardId, dependsOnList] of Object.entries(deps)) {
      graph[cardId] = [...dependsOnList];
    }

    // Apply the new depends_on
    if (newDependsOn.length > 0) {
      graph[id] = [...newDependsOn];
    } else {
      delete graph[id];
    }

    // Also ensure all known cards are in the graph (even with empty deps)
    const allCards = this.loadIndex();
    for (const cardId of Object.keys(allCards.cards)) {
      if (!(cardId in graph)) {
        graph[cardId] = [];
      }
    }

    // DFS-based cycle detection
    const visited = new Set<string>();
    const stack = new Set<string>();

    function dfs(node: string, path: string[]): string[] | null {
      if (stack.has(node)) {
        // Found a cycle: extract it from the path
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

    // Start DFS from the target card
    const result = dfs(id, []);
    return result ?? [];
  }

  // ── Status Transitions ───────────────────────────────────

  /**
   * Set the status of a card. Validates the status value.
   */
  setStatus(id: string, newStatus: CardStatus): CardRecord {
    return this.update(id, { status: newStatus });
  }

  // ── Activation & Plan Card ───────────────────────────────

  /**
   * Activate a goal (or the project card): transition to 'active' and
   * auto-create a plan card as its first child.
   *
   * Returns both the updated goal card and the new plan card.
   *
   * Plan card ID format: `plan-{goalId}`
   * Plan card is always the first child of the goal.
   * Only one plan per goal.
   */
  activateGoal(id: string): { goal: CardRecord; plan: CardRecord } {
    const goal = this.read(id);
    if (!goal) {
      throw new Error(`Goal '${id}' not found.`);
    }

    if (goal.type !== 'project' && goal.type !== 'goal') {
      throw new Error(`activateGoal requires a project or goal card, got type '${goal.type}'.`);
    }

    // Check if a plan already exists for this goal
    const planId = `${PLAN_CARD_ID_PREFIX}${id}`;
    const existingPlan = this.read(planId);
    if (existingPlan) {
      // Goal already has a plan — just activate the goal
      const updatedGoal = this.update(id, { status: 'active' });
      return { goal: updatedGoal, plan: existingPlan };
    }

    // Activate the goal
    const updatedGoal = this.update(id, { status: 'active' });

    // Create plan card
    const plan: CardRecord = {
      id: planId,
      type: 'plan',
      parent: id,
      depth: updatedGoal.depth + 1,
      title: `Plan for ${updatedGoal.title}`,
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      created_at: now(),
      updated_at: now(),
      assigned_to: null,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      result: null,
      metrics: null,
      artifacts: [],
      attachments: [],
      estimate: null,
      started_at: null,
      completed_at: null,
      duration_ms: null,
      error: null,
      retries: 0,
    };

    // Validate
    const parsed = cardRecordSchema.safeParse(plan);
    if (!parsed.success) {
      throw new Error(`Plan card validation failed: ${parsed.error.message}`);
    }

    // Write plan card
    this.writeCard(plan);

    // Add to index
    this.addToIndex(plan);

    // Add to parent's children — prepend to make it the first child
    const siblings = this.loadChildren(id);
    const newChildren = [planId, ...siblings.filter((c) => c !== planId)];
    this.saveChildren(id, newChildren);

    // Recompute blocks for consistency (plan cards have empty depends_on so
    // this is harmless but consistent with create/update/delete pattern)
    this.recomputeBlocks();

    return { goal: updatedGoal, plan };
  }
}
