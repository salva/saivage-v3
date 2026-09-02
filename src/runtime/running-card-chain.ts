import type { CardRecord } from '../schemas/index.js';
import { cardParentId } from '../schemas/card-id.js';

export interface LinkedCardReader {
  read(cardId: string): CardRecord | null;
  listChildren(cardId: string): string[];
}

export function selectLinkedRunningChain(cards: LinkedCardReader): readonly CardRecord[] {
  const root = cards.read('project');
  if (!root) throw new Error("Root card record 'project' is missing.");
  const linkedChildren = new Map<string, readonly CardRecord[]>();
  const runningCards: CardRecord[] = [];
  const visit = (parent: CardRecord): void => {
    if (parent.lifecycle.status === 'running') runningCards.push(parent);
    const children = cards.listChildren(parent.id).map((id) => {
      const child = cards.read(id);
      if (!child) throw new Error(`Linked child '${id}' of '${parent.id}' is missing.`);
      if (cardParentId(child.id) !== parent.id) throw new Error(`Linked child '${id}' does not name '${parent.id}' as its parent.`);
      return child;
    });
    linkedChildren.set(parent.id, children);
    for (const child of children) visit(child);
  };
  visit(root);

  const chain: CardRecord[] = [];
  let current: CardRecord | undefined = root.lifecycle.status === 'running' ? root : undefined;
  while (current) {
    chain.push(current);
    const runningChildren = linkedChildren.get(current.id)!.filter((child) => child.lifecycle.status === 'running');
    if (runningChildren.length > 1) throw new Error(`Running card '${current.id}' has more than one running direct child.`);
    current = runningChildren[0];
  }
  const selected = new Set(chain.map((card) => card.id));
  const outside = runningCards.find((card) => !selected.has(card.id));
  if (outside) throw new Error(`Linked running card '${outside.id}' is outside the unique project-rooted running chain.`);
  return Object.freeze(chain);
}
