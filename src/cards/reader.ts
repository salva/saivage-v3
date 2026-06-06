import type { CardRecord, CardStatus } from '../schemas/index.js';
import type { CardStoreState } from './state.js';
import { canTransition as canLifecycleTransition } from './lifecycle.js';

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class CardReader {
  constructor(private readonly stateProvider: () => CardStoreState) {}

  read(id: string): CardRecord | null {
    const card = this.stateProvider().get(id);
    return card ? deepClone(card) : null;
  }

  list(): CardRecord[] {
    return this.stateProvider().list().map((card) => deepClone(card));
  }

  listChildren(parentId: string): string[] {
    return this.stateProvider().childrenOf(parentId);
  }

  getParent(id: string): string | null {
    return this.stateProvider().parentOf(id);
  }

  getAncestors(id: string): string[] {
    return this.stateProvider().ancestorsOf(id);
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    return this.getAncestors(id).includes(ancestorId);
  }

  getDescendantIds(id: string): string[] {
    return this.stateProvider().descendantsOf(id);
  }

  detectCycles(id: string, newDependsOn: string[]): string[] {
    return this.stateProvider().detectDependsOnCycle(id, newDependsOn);
  }

  blocksFor(id: string): string[] {
    return this.stateProvider().blocksFor(id);
  }

  canTransition(from: CardStatus, to: CardStatus): boolean {
    return canLifecycleTransition(from, to);
  }
}
