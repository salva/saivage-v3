import type { CardRecord } from '../schemas/index.js';
import { PROJECT_CARD_ID } from './project-card.js';
import { isTerminalType } from './lifecycle.js';
import { CardServiceInvariantError } from './errors.js';

export interface ValidateParsedCardsInput {
  cards: CardRecord[];
  maxDepth: number;
}

export interface ValidateParsedCardsResult {
  depthById: Map<string, number>;
  cardsInDepthOrder: CardRecord[];
}

export function validateParsedCards({ cards, maxDepth }: ValidateParsedCardsInput): ValidateParsedCardsResult {
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const projectCards = cards.filter((c) => c.type === 'project');
  if (projectCards.length > 1) {
    throw new CardServiceInvariantError(
      `Multiple project cards on disk: ${projectCards.map((c) => c.id).join(', ')}.`,
    );
  }
  const projectCard = projectCards[0];
  if (projectCard) {
    if (projectCard.id !== PROJECT_CARD_ID) {
      throw new CardServiceInvariantError(
        `Project card '${projectCard.id}' is invalid: expected canonical id '${PROJECT_CARD_ID}'.`,
      );
    }
    if (projectCard.parent !== null || projectCard.depth !== 0) {
      throw new CardServiceInvariantError(
        `Project card '${projectCard.id}' must be the root card with parent null and depth 0.`,
      );
    }
  }
  for (const card of cards) {
    if (card.parent === card.id) throw new CardServiceInvariantError(`Card '${card.id}' cannot parent itself.`);
    if (card.parent !== null && !byId.has(card.parent)) {
      throw new CardServiceInvariantError(`Card '${card.id}' references missing parent '${card.parent}'.`);
    }
    if (card.parent !== null) {
      const parent = byId.get(card.parent)!;
      if (isTerminalType(parent.type)) {
        throw new CardServiceInvariantError(
          `Terminal card '${parent.id}' (type=${parent.type}) cannot be parent of '${card.id}'.`,
        );
      }
    }
    for (const dep of card.depends_on) {
      if (!byId.has(dep)) throw new CardServiceInvariantError(`Card '${card.id}' depends_on missing card '${dep}'.`);
    }
  }

  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const computeDepth = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new CardServiceInvariantError(`Card hierarchy contains a cycle at '${id}'.`);
    visiting.add(id);
    const card = byId.get(id)!;
    const depth = card.parent === null ? 0 : computeDepth(card.parent) + 1;
    visiting.delete(id);
    if (depth > maxDepth) throw new CardServiceInvariantError(`Card '${id}' depth ${depth} exceeds maximum ${maxDepth}.`);
    if (card.depth !== depth) throw new CardServiceInvariantError(`Card '${id}' stores depth ${card.depth}, expected ${depth}.`);
    depthById.set(id, depth);
    return depth;
  };
  for (const card of cards) computeDepth(card.id);

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

  return {
    depthById,
    cardsInDepthOrder: [...cards].sort((a, b) => (depthById.get(a.id) ?? 0) - (depthById.get(b.id) ?? 0)),
  };
}
