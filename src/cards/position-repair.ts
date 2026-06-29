import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { EventBus } from '../events/index.js';
import { ProjectLock } from '../persistence/index.js';
import { cardRecordSchema, type CardRecord } from '../schemas/index.js';
import { applyMutationGroupSync, type ApplyMutationOp } from './apply-mutation.js';
import { CardStoreState } from './state.js';
import { cardRecordsRoot, cardRecordVersionPath } from '../persistence/card-loader.js';
import { readRecordSlotIndex } from '../runtime/records/record-slots.js';

function readRawCards(projectRoot: string): CardRecord[] {
  const dir = cardRecordsRoot(projectRoot);
  if (!existsSync(dir)) return [];
  const cards: CardRecord[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const index = readRecordSlotIndex(projectRoot, entry.name, 'card');
    if (index.latest === null) continue;
    const path = cardRecordVersionPath(projectRoot, entry.name, index.latest);
    try {
      cards.push(cardRecordSchema.parse(JSON.parse(readFileSync(path, 'utf-8'))));
    } catch {
      // Leave non-position corruption fail-closed in loadCardStoreState.
    }
  }
  return cards;
}

function siblingGroups(state: CardStoreState): Map<string, string[]> {
  const parentIds = new Set<string>();
  for (const card of state.list()) {
    if (card.parent !== null) parentIds.add(card.parent);
  }
  const groups = new Map<string, string[]>();
  for (const parentId of parentIds) groups.set(parentId, state.childrenOf(parentId));
  return groups;
}

/**
 * Deterministically repair duplicate or non-contiguous sibling positions left by
 * interrupted delete/reorder writes. This runs before strict boot validation, so
 * it builds a permissive throwaway state and only persists changed positions via
 * the normal mutation path, preserving history and version_seq. All other store
 * invariants remain the responsibility of loadCardStoreState and still fail
 * closed.
 */
export function repairSiblingPositions(
  projectRoot: string,
  maxDepth: number,
  projectLock: ProjectLock,
  eventBus: EventBus,
): void {
  const cards = readRawCards(projectRoot);
  if (cards.length === 0) return;

  const state = new CardStoreState(maxDepth);
  const rawById = new Map(cards.map((card) => [card.id, card] as const));
  for (const card of [...cards].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))) {
    state.upsert(card);
  }

  const updatedAt = new Date().toISOString();
  const ops: ApplyMutationOp[] = [];
  for (const childIds of siblingGroups(state).values()) {
    childIds.forEach((id, index) => {
      const card = rawById.get(id);
      if (!card || card.position === index) return;
      ops.push({
        kind: 'persist',
        next: {
          ...card,
          position: index,
          updated_at: updatedAt,
          version_seq: card.version_seq + 1,
        },
        historyKind: 'mutate',
        ctx: { actor: 'runtime', surface: 'runtime', reason: 'startup position repair' },
        changedFields: ['position'],
        changeSummary: 'startup position repair',
      });
    });
  }

  applyMutationGroupSync({ projectRoot, state, projectLock, eventBus }, ops);
}
