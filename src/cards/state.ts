// F13 r5 §"Read model" — in-memory snapshot of every CardRecord plus derived
// adjacency. The single source of truth for `CardStore` reads. Mutated only
// by applyMutation under the project lock.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cardHistoryEntrySchema,
  cardRecordSchema,
  validatePersistedCardLifecycle,
  type CardHistoryEntry,
  type CardRecord,
} from '../schemas/index.js';
import { lastLineSync } from '../persistence/index.js';
import { PROJECT_CARD_ID } from './project-card.js';
import { isTerminalType } from './lifecycle.js';

export class CardStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStoreInvariantError';
  }
}

export class ReorderSetMismatchError extends Error {
  constructor(
    public readonly parentId: string,
    public readonly missing: string[],
    public readonly extra: string[],
  ) {
    super(`Reorder child set mismatch for parent '${parentId}': missing=[${missing.join(',')}], extra=[${extra.join(',')}].`);
    this.name = 'ReorderSetMismatchError';
  }
}

function byIdDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'by-id');
}

function historyDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'cards', 'history');
}

export function cardByIdPath(projectRoot: string, id: string): string {
  return join(byIdDir(projectRoot), `${id}.json`);
}

export function cardHistoryPath(projectRoot: string, id: string): string {
  return join(historyDir(projectRoot), `${id}.history.jsonl`);
}

export class CardStoreState {
  private readonly _cards = new Map<string, CardRecord>();
  // Invariant: every array is sorted by each child card's persisted position.
  private readonly _childrenByParent = new Map<string, string[]>();
  private readonly _blocksInverse = new Map<string, string[]>();
  private readonly _depthCache = new Map<string, number>();
  private readonly __RESERVED_IDS = new Set<string>();
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    this.maxDepth = maxDepth;
  }

  get cards(): ReadonlyMap<string, CardRecord> {
    return this._cards;
  }

  has(id: string): boolean {
    return this._cards.has(id);
  }

  get(id: string): CardRecord | undefined {
    return this._cards.get(id);
  }

  list(): CardRecord[] {
    return Array.from(this._cards.values());
  }

  parentOf(id: string): string | null {
    return this._cards.get(id)?.parent ?? null;
  }

  childrenOf(parentId: string): string[] {
    return [...(this._childrenByParent.get(parentId) ?? [])];
  }

  reorderChildren(parentId: string, orderedChildIds: string[]): { changed: string[]; nextPositions: Map<string, number> } {
    const current = this.childrenOf(parentId);
    const desired = [...orderedChildIds];
    const currentSet = new Set(current);
    const desiredSet = new Set(desired);
    const missing = current.filter((id) => !desiredSet.has(id));
    const extra = desired.filter((id, index) => !currentSet.has(id) || desired.indexOf(id) !== index);
    if (missing.length > 0 || extra.length > 0 || desired.length !== desiredSet.size) {
      throw new ReorderSetMismatchError(parentId, missing, extra);
    }
    const nextPositions = new Map<string, number>();
    const changed: string[] = [];
    desired.forEach((id, index) => {
      nextPositions.set(id, index);
      const card = this._cards.get(id);
      if (card && card.position !== index) changed.push(id);
    });
    return { changed, nextPositions };
  }

  descendantsOf(parentId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const stack = [...this.childrenOf(parentId)].reverse();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);
      stack.push(...this.childrenOf(id).reverse());
    }
    return result;
  }

  ancestorsOf(id: string): string[] {
    const ancestors: string[] = [];
    let current = this._cards.get(id);
    while (current && current.parent !== null) {
      ancestors.unshift(current.parent);
      current = this._cards.get(current.parent);
    }
    return ancestors;
  }

  depthOf(id: string): number | undefined {
    return this._depthCache.get(id);
  }

  blocksFor(dependencyId: string): string[] {
    return [...(this._blocksInverse.get(dependencyId) ?? [])];
  }

  /** Upsert a card and recompute adjacency. Caller must hold the project lock. */
  upsert(card: CardRecord): void {
    const prior = this._cards.get(card.id);
    if (prior && prior.parent !== card.parent) this.removeChildEdge(prior.parent, card.id);
    if (prior) this.removeBlocksEdges(prior.id, prior.depends_on);
    this._cards.set(card.id, { ...card, blocks: this.computeBlocksArrayFor(card.id, card.depends_on) });
    this.addChildEdge(card.parent, card.id);
    this.addBlocksEdges(card.id, card.depends_on);
    this.refreshBlocksField(card.id);
    this._depthCache.clear();
  }

  /** Remove a card and recompute adjacency. The removed ID becomes reserved. */
  remove(id: string): void {
    const prior = this._cards.get(id);
    if (!prior) return;
    this.removeChildEdge(prior.parent, id);
    this.removeBlocksEdges(id, prior.depends_on);
    this._cards.delete(id);
    this._blocksInverse.delete(id);
    this.__RESERVED_IDS.add(id);
    this._depthCache.clear();
  }

  /** All IDs that are either live cards or reserved by history/archive. */
  allKnownIds(): string[] {
    const ids = new Set(this.__RESERVED_IDS);
    for (const card of this._cards.values()) ids.add(card.id);
    return [...ids].sort();
  }

  /** Mark an ID as reserved (used by history/archive at boot). */
  addReservedId(id: string): void {
    this.__RESERVED_IDS.add(id);
  }

  /** Check whether an ID is reserved by history or archive but not currently a live card. */
  isReservedId(id: string): boolean {
    return this.__RESERVED_IDS.has(id) && !this._cards.has(id);
  }

  private sortChildEdges(parent: string): void {
    const arr = this._childrenByParent.get(parent);
    if (!arr) return;
    arr.sort((a, b) => {
      const ac = this._cards.get(a);
      const bc = this._cards.get(b);
      return (ac?.position ?? 0) - (bc?.position ?? 0) || a.localeCompare(b);
    });
    this._childrenByParent.set(parent, arr);
  }

  private addChildEdge(parent: string | null, childId: string): void {
    if (parent === null) return;
    const arr = this._childrenByParent.get(parent) ?? [];
    if (!arr.includes(childId)) arr.push(childId);
    this._childrenByParent.set(parent, arr);
    this.sortChildEdges(parent);
  }

  private removeChildEdge(parent: string | null, childId: string): void {
    if (parent === null) return;
    const arr = this._childrenByParent.get(parent);
    if (!arr) return;
    const filtered = arr.filter((c) => c !== childId);
    if (filtered.length === 0) this._childrenByParent.delete(parent);
    else {
      this._childrenByParent.set(parent, filtered);
      this.sortChildEdges(parent);
    }
  }

  private addBlocksEdges(cardId: string, dependsOn: readonly string[]): void {
    for (const dep of dependsOn) {
      const arr = this._blocksInverse.get(dep) ?? [];
      if (!arr.includes(cardId)) arr.push(cardId);
      this._blocksInverse.set(dep, arr);
    }
  }

  private removeBlocksEdges(cardId: string, dependsOn: readonly string[]): void {
    for (const dep of dependsOn) {
      const arr = this._blocksInverse.get(dep);
      if (!arr) continue;
      const filtered = arr.filter((c) => c !== cardId);
      if (filtered.length === 0) this._blocksInverse.delete(dep);
      else this._blocksInverse.set(dep, filtered);
    }
  }

  private computeBlocksArrayFor(_cardId: string, _dependsOn: readonly string[]): string[] {
    // Blocks array on a card lists ids that depend on this card. Recomputed after
    // every change so derived blocks stay in sync with depends_on adjacency.
    return [...(this._blocksInverse.get(_cardId) ?? [])];
  }

  private refreshBlocksField(cardId: string): void {
    const card = this._cards.get(cardId);
    if (!card) return;
    const computed = this.blocksFor(cardId);
    this._cards.set(cardId, { ...card, blocks: computed });
    // Any card listing `cardId` as a dependency may also need refresh, but blocks
    // arrays are populated lazily on read via blocksFor(); the snapshot stored on
    // each CardRecord matches the inverse map after a full upsert cycle.
    for (const depId of card.depends_on) {
      const depCard = this._cards.get(depId);
      if (!depCard) continue;
      this._cards.set(depId, { ...depCard, blocks: this.blocksFor(depId) });
    }
  }

  detectDependsOnCycle(id: string, newDependsOn: readonly string[]): string[] {
    const graph = new Map<string, readonly string[]>();
    for (const c of this._cards.values()) {
      graph.set(c.id, c.id === id ? newDependsOn : c.depends_on);
    }
    if (!graph.has(id)) graph.set(id, newDependsOn);
    const stack = new Set<string>();
    const visited = new Set<string>();
    const dfs = (node: string, path: string[]): string[] | null => {
      if (stack.has(node)) {
        const start = path.indexOf(node);
        return [...path.slice(start), node];
      }
      if (visited.has(node)) return null;
      visited.add(node);
      stack.add(node);
      for (const n of graph.get(node) ?? []) {
        const r = dfs(n, [...path, node]);
        if (r) return r;
      }
      stack.delete(node);
      return null;
    };
    return dfs(id, []) ?? [];
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function parseCard(raw: unknown, path: string): CardRecord {
  const parsed = cardRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CardStoreInvariantError(
      `Card record at '${path}' is invalid: ${parsed.error.message}`,
    );
  }
  try {
    validatePersistedCardLifecycle(parsed.data);
    if (parsed.data.status !== parsed.data.lifecycle.status) {
      throw new Error(`status '${parsed.data.status}' does not match lifecycle.status '${parsed.data.lifecycle.status}'`);
    }
    return parsed.data;
  } catch (err) {
    throw new CardStoreInvariantError(
      `Card record at '${path}' has invalid lifecycle fields: ${(err as Error).message}`,
    );
  }
}

function parseHistoryLine(line: string, jsonlPath: string, lineNo: number): CardHistoryEntry {
  let json: unknown;
  try {
    json = JSON.parse(line) as unknown;
  } catch (err) {
    throw new CardStoreInvariantError(
      `Card history at '${jsonlPath}' line ${lineNo} is unparseable JSONL: ${(err as Error).message}`,
    );
  }
  const parsed = cardHistoryEntrySchema.safeParse(json);
  if (!parsed.success) {
    throw new CardStoreInvariantError(
      `Card history at '${jsonlPath}' line ${lineNo} failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Read every complete line of a card history file and validate each row. */
export function readHistoryEntriesStrict(jsonlPath: string): CardHistoryEntry[] {
  if (!existsSync(jsonlPath)) return [];
  const raw = readFileSync(jsonlPath, 'utf-8');
  if (raw.length === 0) return [];
  const tail = lastLineSync(jsonlPath);
  if (!tail.endsWithNewline) {
    throw new CardStoreInvariantError(
      `Card history file '${jsonlPath}' ends without a newline (partial last line: ${JSON.stringify(
        tail.partialTail?.slice(0, 80) ?? '',
      )}). Recovery hint: run 'saivage reset' or repair the file by hand.`,
    );
  }
  const lines = raw.split('\n');
  const entries: CardHistoryEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    entries.push(parseHistoryLine(line, jsonlPath, i + 1));
  }
  return entries;
}

/**
 * Per F13 r5 §"Boot recovery" step 6 — verify contiguous history `{1..V-1}` for
 * V>=2, or empty for V===1. Returns the de-duplicated, validated entries.
 */
export function validateCardHistoryInvariant(
  cardId: string,
  cardVersionSeq: number,
  jsonlPath: string,
): CardHistoryEntry[] {
  const entries = readHistoryEntriesStrict(jsonlPath);
  if (cardVersionSeq === 1) {
    if (entries.length > 0) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' has version_seq=1 but history file '${jsonlPath}' contains ${entries.length} row(s). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
    return [];
  }
  // De-duplicate by entry_id (first wins, later duplicates are harmless).
  const seen = new Set<string>();
  const deduped: CardHistoryEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.entry_id)) continue;
    seen.add(e.entry_id);
    deduped.push(e);
  }
  const expected = new Set<number>();
  for (let v = 1; v < cardVersionSeq; v++) expected.add(v);
  const observed = new Set<number>();
  for (const e of deduped) {
    if (e.version_seq < 1) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' contains a row with version_seq=${e.version_seq} (entry_id=${e.entry_id}); positive sequence is required.`,
      );
    }
    observed.add(e.version_seq);
  }
  for (const v of expected) {
    if (!observed.has(v)) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' is missing version_seq=${v} (card.version_seq=${cardVersionSeq}). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
  }
  for (const v of observed) {
    if (!expected.has(v)) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' has orphan version_seq=${v} (card.version_seq=${cardVersionSeq}). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
  }
  return deduped;
}

export interface LoadCardStoreStateOptions {
  maxDepth?: number;
}

/**
 * Load `CardStoreState` from disk: parse every `cards/by-id/*.json`, validate
 * structural invariants (depth, optional project root, parent resolution,
 * no cycles, no terminal children, depends-on closure), validate per-card
 * history contiguity, and build adjacency caches.
 */
export function loadCardStoreState(
  projectRoot: string,
  options: LoadCardStoreStateOptions = {},
): CardStoreState {
  const maxDepth = options.maxDepth !== undefined && options.maxDepth > 0 ? options.maxDepth : 5;
  const state = new CardStoreState(maxDepth);
  const dir = byIdDir(projectRoot);
  if (!existsSync(dir)) return state;
  const entries = readdirSync(dir).filter((n) => n.endsWith('.json'));
  const cardsRaw: CardRecord[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    cardsRaw.push(parseCard(readJsonFile(path), path));
  }
  const byId = new Map(cardsRaw.map((c) => [c.id, c] as const));
  const projectCards = cardsRaw.filter((c) => c.type === 'project');
  if (projectCards.length > 1) {
    throw new CardStoreInvariantError(
      `Multiple project cards on disk: ${projectCards.map((c) => c.id).join(', ')}.`,
    );
  }
  const projectCard = projectCards[0];
  const hasMaterializedProject = projectCard !== undefined;
  if (projectCard) {
    if (projectCard.id !== PROJECT_CARD_ID) {
      throw new CardStoreInvariantError(
        `Project card '${projectCard.id}' is invalid: expected canonical id '${PROJECT_CARD_ID}'.`,
      );
    }
    if (projectCard.parent !== null || projectCard.depth !== 0 || projectCard.position !== 0) {
      throw new CardStoreInvariantError(
        `Project card '${projectCard.id}' must be the root card with parent null, depth 0, and position 0.`,
      );
    }
  }
  for (const card of cardsRaw) {
    if (card.parent === card.id) {
      throw new CardStoreInvariantError(`Card '${card.id}' cannot parent itself.`);
    }
    const hasVirtualProjectParent =
      !hasMaterializedProject && card.parent === PROJECT_CARD_ID;
    if (card.parent !== null && !byId.has(card.parent) && !hasVirtualProjectParent) {
      throw new CardStoreInvariantError(
        `Card '${card.id}' references missing parent '${card.parent}'.`,
      );
    }
    if (card.parent !== null && !hasVirtualProjectParent) {
      const parent = byId.get(card.parent)!;
      if (isTerminalType(parent.type)) {
        throw new CardStoreInvariantError(
          `Terminal card '${parent.id}' (type=${parent.type}) cannot be parent of '${card.id}'.`,
        );
      }
    }
    for (const dep of card.depends_on) {
      if (!byId.has(dep)) {
        throw new CardStoreInvariantError(
          `Card '${card.id}' depends_on missing card '${dep}'.`,
        );
      }
    }
  }
  // Depth computation + cycle detection on parent edges.
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const computeDepth = (id: string): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      throw new CardStoreInvariantError(`Card hierarchy contains a cycle at '${id}'.`);
    }
    visiting.add(id);
    const card = byId.get(id)!;
    const hasVirtualProjectParent =
      !hasMaterializedProject && card.parent === PROJECT_CARD_ID;
    const d = card.parent === null ? 0 : hasVirtualProjectParent ? 1 : computeDepth(card.parent) + 1;
    visiting.delete(id);
    if (d > maxDepth) {
      throw new CardStoreInvariantError(
        `Card '${id}' depth ${d} exceeds maximum ${maxDepth}.`,
      );
    }
    if (card.depth !== d) {
      throw new CardStoreInvariantError(
        `Card '${id}' stores depth ${card.depth}, expected ${d}.`,
      );
    }
    depthMemo.set(id, d);
    return d;
  };
  for (const c of cardsRaw) computeDepth(c.id);
  // Now seed state via upsert in deterministic order (parents first by depth).
  const inDepthOrder = [...cardsRaw].sort(
    (a, b) => (depthMemo.get(a.id) ?? 0) - (depthMemo.get(b.id) ?? 0),
  );
  for (const card of inDepthOrder) state.upsert(card);
  const childrenByParent = new Map<string, CardRecord[]>();
  for (const card of cardsRaw) {
    if (card.parent === null) {
      if (card.position !== 0) {
        throw new CardStoreInvariantError(`Root card '${card.id}' has position ${card.position}, expected 0; recovery hint: 'saivage init'.`);
      }
      continue;
    }
    const arr = childrenByParent.get(card.parent) ?? [];
    arr.push(card);
    childrenByParent.set(card.parent, arr);
  }
  for (const [parentId, children] of childrenByParent.entries()) {
    const positions = children.map((child) => child.position).sort((a, b) => a - b);
    const contiguous = positions.every((position, index) => position === index);
    if (!contiguous) {
      throw new CardStoreInvariantError(`Parent '${parentId}' has non-contiguous child positions: [${positions.join(',')}]; recovery hint: 'saivage init'.`);
    }
  }
  // Per-card history contiguity invariant.
  for (const card of cardsRaw) {
    validateCardHistoryInvariant(card.id, card.version_seq, cardHistoryPath(projectRoot, card.id));
  }
  // Collect IDs that exist in history or archive but are NOT live cards.
  // These are reserved: the generator must never reuse them.
  const liveIdSet = new Set(cardsRaw.map((c) => c.id));
  const historicDir = historyDir(projectRoot);
  if (existsSync(historicDir)) {
    for (const name of readdirSync(historicDir)) {
      if (!name.endsWith('.history.jsonl')) continue;
      const id = name.slice(0, -'.history.jsonl'.length);
      if (!liveIdSet.has(id)) state.addReservedId(id);
    }
  }
  const archiveDir = join(projectRoot, '.saivage', 'archive', 'cards');
  if (existsSync(archiveDir)) {
    for (const name of readdirSync(archiveDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!liveIdSet.has(id)) state.addReservedId(id);
    }
  }
  return state;
}
