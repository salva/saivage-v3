import type { CardRecord } from '../schemas/index.js';

export interface LinkedCardReader {
  read(cardId: string): CardRecord | null;
  listChildren(cardId: string): string[];
}

export function selectLinkedRunningChain(cards: LinkedCardReader): readonly CardRecord[] {
  const root = cards.read('project');
  if (!root) throw new Error("Root card record 'project' is missing.");
  if (root.status !== 'running') return Object.freeze([]);
  const chain: CardRecord[] = [root];
  let current = root;
  for (;;) {
    const runningChildren = cards.listChildren(current.id).map((id) => {
      const child = cards.read(id);
      if (!child) throw new Error(`Linked child '${id}' of '${current.id}' is missing.`);
      if (child.parent !== current.id) throw new Error(`Linked child '${id}' does not name '${current.id}' as its parent.`);
      return child;
    }).filter((child) => child.status === 'running');
    if (runningChildren.length > 1) throw new Error(`Running card '${current.id}' has more than one running direct child.`);
    const child = runningChildren[0];
    if (!child) return Object.freeze(chain);
    chain.push(child);
    current = child;
  }
}
