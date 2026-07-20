import type { CardRecord } from '../schemas/index.js';

export class CardIndex {
  private readonly _cards = new Map<string, CardRecord>();

  get(id: string): CardRecord | undefined {
    return this._cards.get(id);
  }

  list(): CardRecord[] {
    return Array.from(this._cards.values());
  }

  childrenOf(parentId: string): string[] {
    const parent = this._cards.get(parentId);
    return parent ? parent.children.filter((id) => this._cards.has(id)) : [];
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

  upsert(card: CardRecord): void {
    this._cards.set(card.id, { ...card });
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
