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

}
