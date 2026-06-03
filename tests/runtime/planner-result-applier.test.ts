import { describe, expect, it } from '@jest/globals';
import { PlannerResultApplier } from '../../src/runtime/phases/planner-result-applier.js';
import type { CardRecord } from '../../src/schemas/types.js';

describe('PlannerResultApplier', () => {
  it('creates new planner cards and updates tracked fields/status', async () => {
    const created: unknown[] = [];
    const mutated: unknown[] = [];
    const transitions: unknown[] = [];
    const existing = new Set<string>();
    const applier = new PlannerResultApplier({
      cardStore: {
        read: (id) => (existing.has(id) ? ({ id } as CardRecord) : null),
        create: (card) => {
          created.push(card);
          if (card.id) existing.add(card.id);
        },
        mutateCard: (id, changes, meta) => mutated.push({ id, changes, meta }),
      },
      transitionCard: async (id, action, input) => {
        transitions.push({ id, action, input });
      },
    });

    await applier.apply('goal-a', {
      status: 'continue',
      created_cards: [{ id: 'child-a', type: 'code', title: 'Child', description: 'Do it', status: 'backlog', depends_on: [], priority: 1 }],
      updated_cards: [{ id: 'child-a', title: 'Updated', status: 'blocked' }],
    });

    expect(created).toHaveLength(1);
    expect(mutated).toEqual([expect.objectContaining({ id: 'child-a', changes: { title: 'Updated' } })]);
    expect(transitions).toEqual([{ id: 'child-a', action: 'planner_set_status', input: { requestedStatus: 'blocked' } }]);
  });
});
