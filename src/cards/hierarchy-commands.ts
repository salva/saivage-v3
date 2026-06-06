import type { CardRecord } from '../schemas/index.js';
import { now } from '../utils/clock.js';
import { PROJECT_CARD_ID } from './project-card.js';
import { ReorderSetMismatchError } from './errors.js';
import type { CardStoreState } from './state.js';
import {
  applyMutationGroupSync,
  type ApplyMutationDeps,
  type ApplyMutationOp,
} from './apply-mutation.js';
import type { CardMutationContext } from './lifecycle.js';
import type { CardPatchHistoryKind } from './card-patch-service.js';

export type ReorderChildrenResult =
  | { ok: true; changed: number }
  | { ok: false; reason: 'reorder_set_mismatch'; missing: string[]; extra: string[] };

export interface CardHierarchyCommandsConfig {
  state: () => CardStoreState;
  deps: () => ApplyMutationDeps;
  applyPatch: (
    id: string,
    changes: Partial<CardRecord>,
    historyKind: CardPatchHistoryKind,
    ctx: CardMutationContext,
  ) => CardRecord;
}

function persistOp(next: CardRecord, ctx: CardMutationContext, changedFields: string[], changeSummary: string): ApplyMutationOp {
  return { kind: 'persist', next, historyKind: 'mutate', ctx, changedFields, changeSummary };
}

export class CardHierarchyCommands {
  constructor(private readonly config: CardHierarchyCommandsConfig) {}

  reorderChildren(parentId: string, orderedChildIds: string[], ctx: CardMutationContext): ReorderChildrenResult {
    const state = this.config.state();
    if (parentId !== PROJECT_CARD_ID && !state.get(parentId)) {
      throw new Error(`Parent card '${parentId}' does not exist.`);
    }
    let plan: { changed: string[]; nextPositions: Map<string, number> };
    try {
      plan = state.reorderChildren(parentId, orderedChildIds);
    } catch (err) {
      if (err instanceof ReorderSetMismatchError) return { ok: false, reason: 'reorder_set_mismatch', missing: err.missing, extra: err.extra };
      throw err;
    }
    if (plan.changed.length === 0) return { ok: true, changed: 0 };
    const stamp = now();
    const ops: ApplyMutationOp[] = [];
    for (const childId of plan.changed) {
      const child = state.get(childId);
      const position = plan.nextPositions.get(childId);
      if (!child || position === undefined) continue;
      const next = { ...child, position, updated_at: stamp, version_seq: child.version_seq + 1 };
      ops.push(persistOp(next, ctx, ['position'], 'reorder_child'));
    }
    applyMutationGroupSync(this.config.deps(), ops);
    return { ok: true, changed: ops.length };
  }

  updateDependsOn(
    id: string,
    newDependsOn: string[],
    ctx: CardMutationContext = {
      actor: 'runtime',
      surface: 'runtime',
      reason: 'dependency update',
    },
  ): CardRecord {
    return this.config.applyPatch(id, { depends_on: newDependsOn }, 'depends', ctx);
  }
}
