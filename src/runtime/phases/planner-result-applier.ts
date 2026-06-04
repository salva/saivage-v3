import type { PlannerResult } from '../../contracts/index.js';
import type { CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardMutationContext, NewCardInput } from '../../cards/store-api.js';
import { commitPlannerDone } from '../terminal-commit/index.js';

export interface PlannerResultCardStore {
  read(cardId: string): CardRecord | null | undefined;
  create(card: NewCardInput): unknown;
  mutateCard(cardId: string, changes: Partial<CardRecord>, meta: CardMutationContext): unknown;
}

export interface PlannerResultApplierDeps {
  cardStore: PlannerResultCardStore;
  now(): string;
  transitionCard(cardId: string, action: 'planner_set_status' | 'complete', input: Record<string, unknown>): Promise<unknown>;
  updateCard(cardId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
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
          const targetCard = this.deps.cardStore.read(update.id);
          if (update.status === 'done' && targetCard && targetCard.type !== 'project' && targetCard.type !== 'goal') {
            await commitPlannerDone({
              card: targetCard,
              createdCards: (plannerResult.created_cards ?? []).map((card) => card.id).filter((id): id is string => Boolean(id)),
              updatedCards: (plannerResult.updated_cards ?? []).map((card) => card.id).filter((id): id is string => Boolean(id)),
              summary: plannerResult.summary ?? 'Planner marked card done.',
              completedAt: this.deps.now(),
              effects: {
                transitionCard: (cardId, event, details) => this.deps.transitionCard(cardId, event as 'complete', details),
                updateCard: (cardId, patch) => this.deps.updateCard(cardId, patch),
              },
            });
          } else {
            await this.deps.transitionCard(update.id, 'planner_set_status', {
              requestedStatus: update.status as CardStatus,
            });
          }
        }
      }
    }
  }
}
