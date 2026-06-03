import type { PlannerResult } from '../../contracts/index.js';
import type { CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardMutationContext } from '../../cards/store-api.js';

export interface PlannerResultCardStore {
  read(cardId: string): CardRecord | null | undefined;
  create(card: Omit<CardRecord, 'id' | 'created_at' | 'updated_at' | 'version_seq' | 'position'> & { id?: string }): unknown;
  mutateCard(cardId: string, changes: Partial<CardRecord>, meta: CardMutationContext): unknown;
}

export interface PlannerResultApplierDeps {
  cardStore: PlannerResultCardStore;
  transitionCard(cardId: string, action: 'planner_set_status', input: { requestedStatus: CardStatus }): Promise<unknown>;
}

export class PlannerResultApplier {
  constructor(private readonly deps: PlannerResultApplierDeps) {}

  async apply(goalId: string, plannerResult: PlannerResult): Promise<void> {
    if (plannerResult.created_cards) {
      for (const cardDef of plannerResult.created_cards) {
        if (this.deps.cardStore.read(cardDef.id ?? '')) continue;
        this.deps.cardStore.create({
          id: cardDef.id,
          type: cardDef.type as CardRecord['type'],
          parent: goalId,
          title: cardDef.title,
          description: cardDef.description,
          status: cardDef.status as CardRecord['status'],
          depends_on: cardDef.depends_on,
          priority: cardDef.priority,
          tags: cardDef.tags ?? [],
          urgency: 'normal',
          created_by: 'planner',
          blocks: [],
          related: [],
          acceptance: '',
          artifacts: [],
          attachments: [],
          retries: 0,
          depth: 0,
        });
      }
    }
    if (plannerResult.updated_cards) {
      for (const update of plannerResult.updated_cards) {
        const trackedChanges: Partial<CardRecord> = {};
        if (update.title !== undefined) trackedChanges.title = update.title;
        if (update.description !== undefined) trackedChanges.description = update.description;
        if (update.acceptance !== undefined) trackedChanges.acceptance = update.acceptance;
        if (Object.keys(trackedChanges).length > 0) {
          this.deps.cardStore.mutateCard(update.id, trackedChanges, {
            actor: 'planner',
            surface: 'runtime',
            reason: 'planner updated card',
          });
        }
        if (update.status !== undefined) {
          await this.deps.transitionCard(update.id, 'planner_set_status', {
            requestedStatus: update.status as CardStatus,
          });
        }
      }
    }
  }
}
