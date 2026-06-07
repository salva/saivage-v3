import type { CardHistoryEntry, CardRecord } from '../schemas/index.js';
import { PROJECT_CARD_ID } from './project-card.js';
import { isTerminalType } from './lifecycle.js';
import { CardStoreInvariantError } from './errors.js';

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
  for (const card of cards) {
    if (card.parent === card.id) throw new CardStoreInvariantError(`Card '${card.id}' cannot parent itself.`);
    const hasVirtualProjectParent = !hasMaterializedProject && card.parent === PROJECT_CARD_ID;
    if (card.parent !== null && !byId.has(card.parent) && !hasVirtualProjectParent) {
      throw new CardStoreInvariantError(`Card '${card.id}' references missing parent '${card.parent}'.`);
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
      if (!byId.has(dep)) throw new CardStoreInvariantError(`Card '${card.id}' depends_on missing card '${dep}'.`);
    }
  }

  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const computeDepth = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new CardStoreInvariantError(`Card hierarchy contains a cycle at '${id}'.`);
    visiting.add(id);
    const card = byId.get(id)!;
    const hasVirtualProjectParent = !hasMaterializedProject && card.parent === PROJECT_CARD_ID;
    const depth = card.parent === null ? 0 : hasVirtualProjectParent ? 1 : computeDepth(card.parent) + 1;
    visiting.delete(id);
    if (depth > maxDepth) throw new CardStoreInvariantError(`Card '${id}' depth ${depth} exceeds maximum ${maxDepth}.`);
    if (card.depth !== depth) throw new CardStoreInvariantError(`Card '${id}' stores depth ${card.depth}, expected ${depth}.`);
    depthById.set(id, depth);
    return depth;
  };
  for (const card of cards) computeDepth(card.id);

  const childrenByParent = new Map<string, CardRecord[]>();
  for (const card of cards) {
    if (card.parent === null) {
      if (card.position !== 0) {
        throw new CardStoreInvariantError(`Root card '${card.id}' has position ${card.position}, expected 0; recovery hint: 'saivage init'.`);
      }
      continue;
    }
    const children = childrenByParent.get(card.parent) ?? [];
    children.push(card);
    childrenByParent.set(card.parent, children);
  }
  for (const [parentId, children] of childrenByParent.entries()) {
    const positions = children.map((child) => child.position).sort((a, b) => a - b);
    if (!positions.every((position, index) => position === index)) {
      throw new CardStoreInvariantError(`Parent '${parentId}' has non-contiguous child positions: [${positions.join(',')}]; recovery hint: 'saivage init'.`);
    }
  }

  return {
    depthById,
    cardsInDepthOrder: [...cards].sort((a, b) => (depthById.get(a.id) ?? 0) - (depthById.get(b.id) ?? 0)),
  };
}

export function validateCardHistoryInvariant(
  cardId: string,
  cardVersionSeq: number,
  jsonlPath: string,
  entries: CardHistoryEntry[],
): CardHistoryEntry[] {
  if (cardVersionSeq === 1) {
    if (entries.length > 0) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' has version_seq=1 but history file '${jsonlPath}' contains ${entries.length} row(s). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
    return [];
  }
  const seen = new Set<string>();
  const deduped: CardHistoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.entry_id)) continue;
    seen.add(entry.entry_id);
    deduped.push(entry);
  }
  const expected = new Set<number>();
  for (let version = 1; version < cardVersionSeq; version++) expected.add(version);
  const observed = new Set<number>();
  for (const entry of deduped) {
    if (entry.version_seq < 1) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' contains a row with version_seq=${entry.version_seq} (entry_id=${entry.entry_id}); positive sequence is required.`,
      );
    }
    observed.add(entry.version_seq);
  }
  for (const version of expected) {
    if (!observed.has(version)) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' is missing version_seq=${version} (card.version_seq=${cardVersionSeq}). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
  }
  for (const version of observed) {
    if (!expected.has(version)) {
      throw new CardStoreInvariantError(
        `Card '${cardId}' history at '${jsonlPath}' has orphan version_seq=${version} (card.version_seq=${cardVersionSeq}). Recovery hint: 'saivage reset' or operator hand-edit.`,
      );
    }
  }
  return deduped;
}
