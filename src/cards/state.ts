import type { CardRecord } from '../schemas/index.js';
import { ReorderSetMismatchError } from './errors.js';

export class CardStoreState {
  private readonly _cards = new Map<string, CardRecord>();
  private readonly _childrenByParent = new Map<string, string[]>();
  private readonly _blocksInverse = new Map<string, string[]>();
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

  blocksFor(dependencyId: string): string[] {
    return [...(this._blocksInverse.get(dependencyId) ?? [])];
  }

  upsert(card: CardRecord): void {
    const prior = this._cards.get(card.id);
    if (prior && prior.parent !== card.parent) this.removeChildEdge(prior.parent, card.id);
    if (prior) this.removeBlocksEdges(prior.id, prior.depends_on);
    this._cards.set(card.id, { ...card });
    this.addChildEdge(card.parent, card.id);
    this.addBlocksEdges(card.id, card.depends_on);
  }

  remove(id: string): void {
    const prior = this._cards.get(id);
    if (!prior) return;
    this.removeChildEdge(prior.parent, id);
    this.removeBlocksEdges(id, prior.depends_on);
    this._cards.delete(id);
    this._blocksInverse.delete(id);
    this.__RESERVED_IDS.add(id);
  }

  allKnownIds(): string[] {
    const ids = new Set(this.__RESERVED_IDS);
    for (const card of this._cards.values()) ids.add(card.id);
    return [...ids].sort();
  }

  addReservedId(id: string): void {
    this.__RESERVED_IDS.add(id);
  }

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

  detectDependsOnCycle(id: string, newDependsOn: readonly string[]): string[] {
    const graph = new Map<string, readonly string[]>();
    for (const card of this._cards.values()) graph.set(card.id, card.id === id ? newDependsOn : card.depends_on);
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
      for (const next of graph.get(node) ?? []) {
        const result = dfs(next, [...path, node]);
        if (result) return result;
      }
      stack.delete(node);
      return null;
    };
    return dfs(id, []) ?? [];
  }
}
