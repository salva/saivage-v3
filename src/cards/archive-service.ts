import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardRecord } from '../schemas/index.js';
import { writeFileSyncDurable } from '../persistence/index.js';
import { now } from '../utils/clock.js';
import { PROJECT_CARD_ID } from './project-card.js';
import { isTerminalState, type CardMutationContext } from './lifecycle.js';
import type { CardStoreState } from './state.js';
import {
  applyMutationGroupSync,
  type ApplyMutationDeps,
  type ApplyMutationOp,
} from './apply-mutation.js';
import { cardHistoryPath } from '../persistence/card-loader.js';

export interface CardArchiveServiceConfig {
  projectRoot: string;
  state: () => CardStoreState;
  deps: () => ApplyMutationDeps;
  read: (id: string) => CardRecord | null;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function archiveCardPath(projectRoot: string, id: string): string {
  return join(projectRoot, '.saivage', 'archive', 'cards', `${id}.json`);
}

function persistOp(next: CardRecord, ctx: CardMutationContext, changedFields: string[], changeSummary: string): ApplyMutationOp {
  return { kind: 'persist', next, historyKind: 'mutate', ctx, changedFields, changeSummary };
}

export class CardArchiveService {
  constructor(private readonly config: CardArchiveServiceConfig) {}

  delete(id: string): void {
    const state = this.config.state();
    const card = this.config.read(id);
    if (!card) throw new Error(`Card '${id}' not found.`);
    if (isTerminalState(card.status)) {
      throw new Error(
        `Cannot delete card '${id}' because it is in status '${card.status}'. Cards in ${card.status} status cannot be deleted.`,
      );
    }
    if (id === PROJECT_CARD_ID) throw new Error('Cannot delete the project card.');
    const children = state.childrenOf(id);
    if (children.length > 0) {
      throw new Error(
        `Cannot delete card '${id}' because it has ${children.length} child(ren). Delete children first.`,
      );
    }
    const ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'delete' };
    const deleteOp: ApplyMutationOp = {
      kind: 'delete',
      cardId: id,
      historyKind: 'delete',
      finalSnapshot: card,
      ctx,
      changeSummary: 'card deleted',
    };
    const compactionOps = this.projectedCompactionOps(
      card.parent,
      new Set([id]),
      { ...ctx, reason: 'delete position compaction' },
    );
    applyMutationGroupSync(this.config.deps(), [deleteOp, ...compactionOps]);
  }

  archiveAndDeleteSubtree(ids: string[]): void {
    const state = this.config.state();
    const idSet = new Set(ids);
    const cards: CardRecord[] = [];
    for (const id of ids) {
      const card = state.get(id);
      if (!card) {
        if (existsSync(archiveCardPath(this.config.projectRoot, id))) continue;
        throw new Error(`Card '${id}' not found.`);
      }
      cards.push(deepClone(card));
    }
    for (const card of cards) {
      for (const childId of state.childrenOf(card.id)) {
        if (!idSet.has(childId)) {
          throw new Error(
            `Card '${card.id}' has child '${childId}' outside the requested delete set.`,
          );
        }
      }
    }
    const archiveDir = join(this.config.projectRoot, '.saivage', 'archive', 'cards');
    mkdirSync(archiveDir, { recursive: true });
    const ctx: CardMutationContext = { actor: 'runtime', surface: 'runtime', reason: 'archive subtree' };
    for (const card of cards) {
      if (!state.get(card.id)) continue;
      const historyFile = cardHistoryPath(this.config.projectRoot, card.id);
      const archivePayload = {
        archived_at: now(),
        card,
        children: state.childrenOf(card.id),
        history: existsSync(historyFile) ? readFileSync(historyFile, 'utf-8') : '',
        result: card.lifecycle.result,
        evidence_refs: { artifacts: card.artifacts, attachments: card.attachments },
      };
      writeFileSyncDurable(archiveCardPath(this.config.projectRoot, card.id), JSON.stringify(archivePayload, null, 2) + '\n');
    }
    const liveCards = cards.filter((card) => state.get(card.id));
    const sorted = [...liveCards].sort((a, b) => b.depth - a.depth);
    const deleteOps: ApplyMutationOp[] = sorted.map((card) => ({
      kind: 'delete',
      cardId: card.id,
      historyKind: 'archive',
      finalSnapshot: card,
      ctx,
      changeSummary: 'card archived',
    }));
    const removed = new Set(liveCards.map((card) => card.id));
    const compactionOps: ApplyMutationOp[] = [];
    for (const parent of new Set(liveCards.map((card) => card.parent))) {
      compactionOps.push(...this.projectedCompactionOps(parent, removed, { ...ctx, reason: 'archive position compaction' }));
    }
    applyMutationGroupSync(this.config.deps(), [...deleteOps, ...compactionOps]);
  }

  private projectedCompactionOps(
    parentId: string | null,
    removedChildIds: ReadonlySet<string>,
    ctx: CardMutationContext,
  ): ApplyMutationOp[] {
    if (parentId === null) return [];
    const state = this.config.state();
    const childIds = state.childrenOf(parentId).filter((childId) => !removedChildIds.has(childId));
    const ops: ApplyMutationOp[] = [];
    const stamp = now();
    childIds.forEach((childId, index) => {
      const child = state.get(childId);
      if (!child || child.position === index) return;
      ops.push(persistOp({ ...child, position: index, updated_at: stamp, version_seq: child.version_seq + 1 }, ctx, ['position'], 'compact_child_positions'));
    });
    return ops;
  }
}
