import type { CardRecord } from '../schemas/index.js';

export function selectRunningCardChain(cards: readonly CardRecord[]): CardRecord[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const running = cards.filter((card) => card.status === 'running');
  if (running.length === 0) return [];
  const leaves = running.filter((candidate) => !running.some((other) => other.parent === candidate.id));
  if (leaves.length !== 1) throw new Error(`Running cards must form one strict ancestor chain; found ${leaves.length} running leaves.`);
  const reversed: CardRecord[] = [];
  let current: CardRecord | undefined = leaves[0];
  while (current) {
    reversed.push(current);
    if (current.parent === null) break;
    const parent = byId.get(current.parent);
    if (!parent || parent.status !== 'running') throw new Error(`Running card '${current.id}' has no running parent '${current.parent}'.`);
    current = parent;
  }
  const chain = reversed.reverse();
  if (chain[0]?.id !== 'project' || chain.length !== running.length) throw new Error('Running cards must form one strict project-rooted ancestor chain.');
  return chain;
}
