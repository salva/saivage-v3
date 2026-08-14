import type { CardRecord } from '../schemas/index.js';
import { CardServiceInvariantError } from './errors.js';

export interface ValidateParsedCardsInput {
  cards: CardRecord[];
}

export function validateParsedCards({ cards }: ValidateParsedCardsInput): void {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  for (const card of cards) {
    for (const dep of card.depends_on) {
      if (!byId.has(dep)) throw new CardServiceInvariantError(`Card '${card.id}' depends_on missing card '${dep}'.`);
    }
  }

  const visitedDependencies = new Set<string>();
  const dependencyStack = new Set<string>();
  const visitDependencies = (id: string): void => {
    if (dependencyStack.has(id)) throw new CardServiceInvariantError(`Card dependency graph contains a cycle at '${id}'.`);
    if (visitedDependencies.has(id)) return;
    dependencyStack.add(id);
    for (const dependency of byId.get(id)!.depends_on) visitDependencies(dependency);
    dependencyStack.delete(id);
    visitedDependencies.add(id);
  };
  for (const card of cards) visitDependencies(card.id);
}
